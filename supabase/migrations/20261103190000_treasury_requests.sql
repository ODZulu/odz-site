-- MVA-217: Treasury requests. A member with a stored balance can give it to a coffers fund
-- (immediate) or ask for it back (a request the Treasurer pays, with Command approval above a
-- threshold). Built on the ledger core (MVA-216, 20261103180000_treasury_ledger.sql). TRACKING
-- ONLY: the app never moves money; "Paid" records that the Treasurer paid it outside the app.
--
-- Rules (from the ticket and Dax's approval ruling)
--   * Donation: treasury_donate() moves cents from the caller's stored balance to a chosen fund as
--     one ledger entry (category 'donation'), applied immediately, no approval. Limited to what is
--     AVAILABLE: balance minus cents reserved by pending refund requests.
--   * Refund request: treasury_request_refund() creates a pending request and RESERVES its amount.
--     Reservations count against the same available balance, so a request cannot be double
--     requested, donated, or spent by a Treasurer transfer while pending. The ledger's balance
--     trigger is redefined (below) so a reservation holds even against a direct insert.
--   * The Treasurer (manage_treasury) pays or rejects. Paid writes the external-withdrawal ledger
--     entry (category 'refund', linked by treasury_entries.request_id, dated with the payment date
--     the Treasurer gives, reference note recorded). Rejected needs a reason; the reservation is
--     released by the status change.
--   * One approval threshold (cents) in treasury_settings, set by Command or Admin. A request at or
--     below it is handled by the Treasurer alone; above it Command must approve first, and the
--     approver cannot be the requester. The comparison is frozen when the request is made
--     (needs_approval, threshold_at_submit) so a later change cannot reclassify a request in flight.
--   * The requester can cancel while pending. Every state change is in treasury_request_log
--     (append-only: who, when, from, to, note).
--   * Visibility: the requester, and the 'full' audience of MVA-216 (Old Guard, Command, Admin,
--     Treasurer); nobody else; anon none. All writes are SECURITY DEFINER RPCs.
--   * The whole module is still DARK SHIP (treasury_settings.member_access, MVA-216): every function
--     here starts from treasury_access(), which is 'none' for everyone but an Admin until go-live.
--
-- Choices beyond the ticket (flagged on the PR): the threshold defaults to 0 (so every request
-- needs Command approval until Command or Admin sets one); nobody can approve, pay or reject their
-- own request.
--
-- Additive only: two new tables, two new columns (treasury_settings.approval_threshold_cents,
-- treasury_entries.request_id), new functions, and one redefined function
-- (treasury_entries_check, copied from 20261103180000_treasury_ledger.sql, the newest definition).

------------------------------------------------------------------------------
-- Threshold setting
------------------------------------------------------------------------------

alter table public.treasury_settings
  add column approval_threshold_cents bigint not null default 0
  check (approval_threshold_cents >= 0 and approval_threshold_cents <= 100000000);

------------------------------------------------------------------------------
-- Requests and their log
------------------------------------------------------------------------------

create table public.treasury_requests (
  id uuid primary key default gen_random_uuid(),
  requester uuid not null,                       -- no FK: the record outlives a removed member
  requester_callsign text,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 100000000),
  note text not null check (length(btrim(note)) between 3 and 500),
  status text not null default 'pending' check (status in ('pending', 'paid', 'rejected', 'cancelled')),
  needs_approval boolean not null,
  threshold_at_submit bigint not null,
  approved_by uuid,
  approved_callsign text,
  approved_at timestamptz,
  decided_by uuid,                               -- who paid or rejected
  decided_callsign text,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) between 3 and 500),
  paid_date date,
  paid_reference text check (paid_reference is null or length(paid_reference) <= 300),
  created_at timestamptz not null default now(),
  constraint treasury_requests_paid_shape check (
    (status = 'paid') = (paid_date is not null)
  ),
  constraint treasury_requests_rejected_shape check (
    status <> 'rejected' or decision_note is not null
  )
);
create index treasury_requests_requester_idx on public.treasury_requests (requester, created_at desc);
create index treasury_requests_pending_idx on public.treasury_requests (created_at) where status = 'pending';

create table public.treasury_request_log (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.treasury_requests (id),
  action text not null check (action in ('requested', 'approved', 'paid', 'rejected', 'cancelled')),
  from_status text,
  to_status text not null,
  actor uuid,
  actor_callsign text,
  note text,
  created_at timestamptz not null default now()
);
create index treasury_request_log_request_idx on public.treasury_request_log (request_id, created_at);

-- Link a payout entry to its request; one payout per request.
alter table public.treasury_entries add column request_id uuid references public.treasury_requests (id);
create unique index treasury_entries_request_key on public.treasury_entries (request_id) where request_id is not null;

create function public.treasury_requests_guard()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'treasury requests cannot be deleted' using errcode = '42501';
  end if;
  -- Identity, amount and the frozen approval rule never change; a closed request never reopens.
  if new.id <> old.id or new.requester <> old.requester or new.amount_cents <> old.amount_cents
     or new.needs_approval <> old.needs_approval or new.threshold_at_submit <> old.threshold_at_submit
     or new.created_at <> old.created_at or new.note <> old.note then
    raise exception 'treasury request fields are fixed' using errcode = '42501';
  end if;
  if old.status <> 'pending' and new.status <> old.status then
    raise exception 'a closed treasury request cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.treasury_requests_guard() from public, anon, authenticated;
create trigger treasury_requests_no_delete before delete on public.treasury_requests
  for each row execute function public.treasury_requests_guard();
create trigger treasury_requests_fixed before update on public.treasury_requests
  for each row execute function public.treasury_requests_guard();

create trigger treasury_request_log_no_update before update on public.treasury_request_log
  for each row execute function public.treasury_immutable();
create trigger treasury_request_log_no_delete before delete on public.treasury_request_log
  for each row execute function public.treasury_immutable();
create trigger treasury_request_log_no_truncate before truncate on public.treasury_request_log
  for each statement execute function public.treasury_immutable();

------------------------------------------------------------------------------
-- Reservations: available = balance - cents reserved by pending requests
------------------------------------------------------------------------------

create function public.treasury_member_reserved_raw(p_member uuid, p_except uuid default null)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(amount_cents), 0)
  from public.treasury_requests
  where requester = p_member and status = 'pending' and id is distinct from p_except;
$$;
revoke all on function public.treasury_member_reserved_raw(uuid, uuid) from public, anon, authenticated;

-- Copied from 20261103180000_treasury_ledger.sql (newest definition; untouched since), plus: a
-- member source must have the amount AVAILABLE, i.e. after pending refund reservations, except the
-- payout of the very request that holds the reservation.
create or replace function public.treasury_entries_check()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('treasury_ledger'));
  if new.from_kind = 'member'
     and public.treasury_member_balance_raw(new.from_member)
         - public.treasury_member_reserved_raw(new.from_member, new.request_id) < new.amount_cents then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;
  if new.from_kind = 'fund' and public.treasury_fund_balance_raw(new.from_fund) < new.amount_cents then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

------------------------------------------------------------------------------
-- RLS: read-only for clients; every write is an RPC
------------------------------------------------------------------------------

revoke all on public.treasury_requests, public.treasury_request_log from anon, authenticated;
grant select on public.treasury_requests, public.treasury_request_log to authenticated;
alter table public.treasury_requests enable row level security;
alter table public.treasury_request_log enable row level security;

-- The row's own columns, not a lookup by id (so inserts and RETURNING see their own row).
create policy treasury_requests_select on public.treasury_requests
  for select to authenticated using (
    public.treasury_access() = 'full'
    or (public.treasury_access() <> 'none' and requester = auth.uid())
  );

create function public.treasury_request_visible(p_request uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.treasury_requests r
    where r.id = p_request
      and (public.treasury_access() = 'full' or (public.treasury_access() <> 'none' and r.requester = auth.uid()))
  );
$$;
revoke all on function public.treasury_request_visible(uuid) from public, anon;
grant execute on function public.treasury_request_visible(uuid) to authenticated;

create policy treasury_request_log_select on public.treasury_request_log
  for select to authenticated using (public.treasury_request_visible(request_id));

------------------------------------------------------------------------------
-- Reads
------------------------------------------------------------------------------

-- Command or Admin, within the module's access gate: may approve and set the threshold.
create function public.treasury_can_approve()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.treasury_access() = 'full' and exists (
    select 1 from public.profiles p
    left join public.tiers t on t.id = p.tier_id
    where p.id = auth.uid() and p.status = 'approved' and (p.is_admin or t.seat_group = 'command')
  );
$$;

-- What the caller can still give or request: stored balance minus pending reservations (cents).
create function public.treasury_my_available()
returns bigint
language sql stable security definer set search_path = ''
as $$
  select case when public.treasury_access() = 'none' then null
              else greatest(0, public.treasury_member_balance_raw(auth.uid()) - public.treasury_member_reserved_raw(auth.uid())) end;
$$;

create function public.treasury_threshold()
returns bigint
language sql stable security definer set search_path = ''
as $$
  select case when public.treasury_access() = 'none' then null
              else (select approval_threshold_cents from public.treasury_settings where singleton) end;
$$;

revoke all on function public.treasury_can_approve() from public, anon;
revoke all on function public.treasury_my_available() from public, anon;
revoke all on function public.treasury_threshold() from public, anon;
grant execute on function public.treasury_can_approve() to authenticated;
grant execute on function public.treasury_my_available() to authenticated;
grant execute on function public.treasury_threshold() to authenticated;

------------------------------------------------------------------------------
-- Writes
------------------------------------------------------------------------------

create function public.treasury_log_request(p_request uuid, p_action text, p_from text, p_to text, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.treasury_request_log (request_id, action, from_status, to_status, actor, actor_callsign, note)
  values (p_request, p_action, p_from, p_to, auth.uid(), (select callsign from public.profiles where id = auth.uid()), p_note);
end;
$$;
revoke all on function public.treasury_log_request(uuid, text, text, text, text) from public, anon, authenticated;

-- Give part of your available balance to a coffers fund. Applies immediately.
create function public.treasury_donate(p_fund uuid, p_amount_cents bigint, p_note text default '')
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_me text;
begin
  if public.treasury_access() = 'none' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 100000000 then
    raise exception 'bad_amount' using errcode = 'P0001';
  end if;
  if length(coalesce(p_note, '')) > 500 then
    raise exception 'bad_note' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.treasury_funds where id = p_fund) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('treasury_ledger'));
  if public.treasury_member_balance_raw(auth.uid()) - public.treasury_member_reserved_raw(auth.uid()) < p_amount_cents then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;
  select callsign into v_me from public.profiles where id = auth.uid();
  insert into public.treasury_entries (
    entry_date, amount_cents,
    from_kind, from_member, from_callsign, to_kind, to_fund,
    category, note, entered_by, entered_by_callsign
  ) values (
    current_date, p_amount_cents,
    'member', auth.uid(), v_me, 'fund', p_fund,
    'donation', coalesce(btrim(p_note), ''), auth.uid(), v_me
  ) returning id into v_id;
  return v_id;
end;
$$;

-- Ask for your available balance back. Creates a pending request and reserves the amount.
create function public.treasury_request_refund(p_amount_cents bigint, p_note text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_thr bigint;
begin
  if public.treasury_access() = 'none' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 100000000 then
    raise exception 'bad_amount' using errcode = 'P0001';
  end if;
  if p_note is null or length(btrim(p_note)) not between 3 and 500 then
    raise exception 'bad_note' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('treasury_ledger'));
  if public.treasury_member_balance_raw(auth.uid()) - public.treasury_member_reserved_raw(auth.uid()) < p_amount_cents then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;
  select approval_threshold_cents into v_thr from public.treasury_settings where singleton;
  insert into public.treasury_requests (requester, requester_callsign, amount_cents, note, needs_approval, threshold_at_submit)
  values (auth.uid(), (select callsign from public.profiles where id = auth.uid()), p_amount_cents, btrim(p_note),
          p_amount_cents > v_thr, v_thr)
  returning id into v_id;
  perform public.treasury_log_request(v_id, 'requested', null, 'pending', null);
  return v_id;
end;
$$;

create function public.treasury_cancel_request(p_request uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.treasury_requests%rowtype;
begin
  if public.treasury_access() = 'none' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('treasury_ledger'));
  select * into r from public.treasury_requests where id = p_request for update;
  if not found or r.requester <> auth.uid() then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if r.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;
  update public.treasury_requests set status = 'cancelled', decided_at = now() where id = p_request;
  perform public.treasury_log_request(p_request, 'cancelled', 'pending', 'cancelled', null);
end;
$$;

-- Command approval for a request above the threshold. Not by the requester.
create function public.treasury_approve_request(p_request uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.treasury_requests%rowtype;
begin
  if not public.treasury_can_approve() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('treasury_ledger'));
  select * into r from public.treasury_requests where id = p_request for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if r.requester = auth.uid() then
    raise exception 'own_request' using errcode = 'P0001';
  end if;
  if r.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;
  if not r.needs_approval then
    raise exception 'no_approval_needed' using errcode = 'P0001';
  end if;
  if r.approved_by is not null then
    raise exception 'already_approved' using errcode = 'P0001';
  end if;
  update public.treasury_requests
     set approved_by = auth.uid(), approved_at = now(),
         approved_callsign = (select callsign from public.profiles where id = auth.uid())
   where id = p_request;
  perform public.treasury_log_request(p_request, 'approved', 'pending', 'pending', null);
end;
$$;

-- The Treasurer marks it paid: writes the external-withdrawal entry and records date and reference.
create function public.treasury_pay_request(p_request uuid, p_paid_date date, p_reference text default '')
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  r public.treasury_requests%rowtype;
  v_entry uuid;
  v_me text;
begin
  if not public.treasury_can_manage() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_paid_date is null or p_paid_date > current_date + 1 or p_paid_date < date '2000-01-01' then
    raise exception 'bad_date' using errcode = 'P0001';
  end if;
  if length(coalesce(p_reference, '')) > 300 then
    raise exception 'bad_note' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('treasury_ledger'));
  select * into r from public.treasury_requests where id = p_request for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if r.requester = auth.uid() then
    raise exception 'own_request' using errcode = 'P0001';
  end if;
  if r.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;
  if r.needs_approval and r.approved_by is null then
    raise exception 'needs_approval' using errcode = 'P0001';
  end if;
  select callsign into v_me from public.profiles where id = auth.uid();
  insert into public.treasury_entries (
    entry_date, amount_cents,
    from_kind, from_member, from_callsign, to_kind,
    category, note, request_id, entered_by, entered_by_callsign
  ) values (
    p_paid_date, r.amount_cents,
    'member', r.requester, r.requester_callsign, 'external',
    'refund', coalesce(nullif(btrim(p_reference), ''), 'Refund paid'), r.id, auth.uid(), v_me
  ) returning id into v_entry;
  update public.treasury_requests
     set status = 'paid', decided_by = auth.uid(), decided_callsign = v_me, decided_at = now(),
         paid_date = p_paid_date, paid_reference = nullif(btrim(p_reference), '')
   where id = p_request;
  perform public.treasury_log_request(p_request, 'paid', 'pending', 'paid', nullif(btrim(p_reference), ''));
  return v_entry;
end;
$$;

-- Treasurer or Command rejects with a reason; the reservation is released by the status change.
create function public.treasury_reject_request(p_request uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.treasury_requests%rowtype;
begin
  if not (public.treasury_can_manage() or public.treasury_can_approve()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'bad_note' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('treasury_ledger'));
  select * into r from public.treasury_requests where id = p_request for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if r.requester = auth.uid() then
    raise exception 'own_request' using errcode = 'P0001';
  end if;
  if r.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;
  update public.treasury_requests
     set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
         decided_callsign = (select callsign from public.profiles where id = auth.uid()),
         decision_note = btrim(p_reason)
   where id = p_request;
  perform public.treasury_log_request(p_request, 'rejected', 'pending', 'rejected', btrim(p_reason));
end;
$$;

-- Command or Admin sets the single approval threshold. Logged.
create function public.set_treasury_approval_threshold(p_cents bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old bigint;
begin
  if not public.treasury_can_approve() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_cents is null or p_cents < 0 or p_cents > 100000000 then
    raise exception 'bad_amount' using errcode = 'P0001';
  end if;
  select approval_threshold_cents into v_old from public.treasury_settings where singleton;
  if v_old = p_cents then
    return;
  end if;
  update public.treasury_settings set approval_threshold_cents = p_cents, updated_at = now(), updated_by = auth.uid() where singleton;
  insert into public.settings_audit (actor_id, event, target, detail)
  values (auth.uid(), 'treasury_threshold_changed', 'treasury', v_old::text || ' -> ' || p_cents::text || ' cents');
end;
$$;

revoke all on function public.treasury_donate(uuid, bigint, text) from public, anon;
revoke all on function public.treasury_request_refund(bigint, text) from public, anon;
revoke all on function public.treasury_cancel_request(uuid) from public, anon;
revoke all on function public.treasury_approve_request(uuid) from public, anon;
revoke all on function public.treasury_pay_request(uuid, date, text) from public, anon;
revoke all on function public.treasury_reject_request(uuid, text) from public, anon;
revoke all on function public.set_treasury_approval_threshold(bigint) from public, anon;
grant execute on function public.treasury_donate(uuid, bigint, text) to authenticated;
grant execute on function public.treasury_request_refund(bigint, text) to authenticated;
grant execute on function public.treasury_cancel_request(uuid) to authenticated;
grant execute on function public.treasury_approve_request(uuid) to authenticated;
grant execute on function public.treasury_pay_request(uuid, date, text) to authenticated;
grant execute on function public.treasury_reject_request(uuid, text) to authenticated;
grant execute on function public.set_treasury_approval_threshold(bigint) to authenticated;
