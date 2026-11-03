-- MVA-216: Treasury ledger core. TRACKING ONLY: the app never holds, moves or collects money;
-- banks do. This is a transparent, append-only record of who is owed what.
--
-- Shape
--   * Buckets: one "stored" balance per member (derived, never stored) and team coffers with named
--     funds (treasury_funds; created and renamed by manage_treasury). Funds are never deleted.
--   * treasury_entries is the ledger. Every change is one row: date, amount in integer cents (> 0),
--     from and to (each external, a member or a fund; not both external), category, note,
--     entered_by, created_at. Rows can never be updated, deleted or truncated (triggers, plus no
--     grant). A correction is a REVERSING entry (opposite direction, `reverses` = the original); an
--     entry can be reversed once, and a reversal cannot itself be reversed.
--   * Balances are derived from the entries (treasury_balances), never kept in a column, so they
--     cannot drift. treasury_reconcile() proves the identity: the sum of every member balance and
--     fund balance equals external in minus external out.
--   * Negative balances are rejected by a BEFORE INSERT trigger (not only the RPC), serialised with
--     a transaction advisory lock so two concurrent entries cannot both spend the same money. A
--     consequence worth knowing: reversing a deposit that has since been spent is refused until the
--     spend is reversed first.
--   * Profile columns carry no foreign key and each entry keeps a callsign snapshot, so the record
--     outlives a removed member (same reasoning as motions, MVA-233).
--   * Writes only through the SECURITY DEFINER RPCs below, which need manage_treasury (already
--     defined by MVA-220: the Treasurer designation; Command inherits it, Admin passes every check).
--     No new capability is needed, so none is added.
--
-- Visibility (treasury_access()):
--   * Below Old Guard a member sees only their own entries and own stored balance ('own').
--   * Old Guard, Command, Admin and manage_treasury holders see the whole ledger with names,
--     every balance and the coffer totals ('full'). Anon sees nothing.
--
-- DARK SHIP (Dax, Block 3): until go-live the whole module is Admin-only. A singleton setting,
-- treasury_settings.member_access, defaults to FALSE; while false treasury_access() is 'full' for an
-- Admin and 'none' for everybody else, so no member can read or write anything. The flip
-- (set_treasury_member_access, Admin only, logged in settings_audit) is the go-live step and is
-- Dax's: it waits on the bylaws, the dedicated bank account and the Chief loop-in. Build and test
-- data are synthetic only.
--
-- Additive only: four new tables, new functions. Redefines nothing.

------------------------------------------------------------------------------
-- Settings (the dark-ship switch)
------------------------------------------------------------------------------

create table public.treasury_settings (
  singleton boolean primary key default true check (singleton),
  member_access boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.treasury_settings (singleton) values (true);

------------------------------------------------------------------------------
-- Access helpers
------------------------------------------------------------------------------

-- 'none' | 'own' | 'full' for the caller. See the header for the dark-ship rule.
create function public.treasury_access()
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when me.id is null then 'none'
    when me.is_admin then 'full'
    when not (select member_access from public.treasury_settings where singleton) then 'none'
    when t.seat_group is not null or public.has_capability('manage_treasury') then 'full'
    else 'own'
  end
  from (select 1) x
  left join public.profiles me on me.id = auth.uid() and me.status = 'approved'
  left join public.tiers t on t.id = me.tier_id;
$$;

-- Treasurer-level: may write the ledger (manage_treasury; Command inherits it, Admin passes).
create function public.treasury_can_manage()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.treasury_access() = 'full' and public.has_capability('manage_treasury');
$$;

revoke all on function public.treasury_access() from public, anon;
revoke all on function public.treasury_can_manage() from public, anon;
grant execute on function public.treasury_access() to authenticated;
grant execute on function public.treasury_can_manage() to authenticated;

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

create table public.treasury_funds (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 60),
  created_by uuid,
  created_at timestamptz not null default now(),
  renamed_at timestamptz
);
create unique index treasury_funds_name_key on public.treasury_funds (lower(btrim(name)));

create table public.treasury_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 100000000),
  from_kind text not null check (from_kind in ('external', 'member', 'fund')),
  from_member uuid,
  from_fund uuid references public.treasury_funds (id),
  from_callsign text,
  to_kind text not null check (to_kind in ('external', 'member', 'fund')),
  to_member uuid,
  to_fund uuid references public.treasury_funds (id),
  to_callsign text,
  category text not null check (category ~ '^[a-z][a-z0-9_]{1,39}$'),
  note text not null default '' check (length(note) <= 500),
  reverses uuid references public.treasury_entries (id),
  entered_by uuid not null,
  entered_by_callsign text,
  created_at timestamptz not null default now(),
  constraint treasury_from_shape check (
    (from_kind = 'external' and from_member is null and from_fund is null)
    or (from_kind = 'member' and from_member is not null and from_fund is null)
    or (from_kind = 'fund' and from_fund is not null and from_member is null)
  ),
  constraint treasury_to_shape check (
    (to_kind = 'external' and to_member is null and to_fund is null)
    or (to_kind = 'member' and to_member is not null and to_fund is null)
    or (to_kind = 'fund' and to_fund is not null and to_member is null)
  ),
  constraint treasury_not_both_external check (not (from_kind = 'external' and to_kind = 'external')),
  constraint treasury_not_to_self check (
    not (from_kind = 'member' and to_kind = 'member' and from_member = to_member)
    and not (from_kind = 'fund' and to_kind = 'fund' and from_fund = to_fund)
  )
);

-- An entry is reversed at most once.
create unique index treasury_entries_reverses_key on public.treasury_entries (reverses) where reverses is not null;
create index treasury_entries_date_idx on public.treasury_entries (entry_date desc, created_at desc);
create index treasury_entries_from_member_idx on public.treasury_entries (from_member) where from_member is not null;
create index treasury_entries_to_member_idx on public.treasury_entries (to_member) where to_member is not null;
create index treasury_entries_from_fund_idx on public.treasury_entries (from_fund) where from_fund is not null;
create index treasury_entries_to_fund_idx on public.treasury_entries (to_fund) where to_fund is not null;

------------------------------------------------------------------------------
-- Immutability
------------------------------------------------------------------------------

create function public.treasury_immutable()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'treasury_entries is append-only' using errcode = '42501';
end;
$$;
revoke all on function public.treasury_immutable() from public, anon, authenticated;

create trigger treasury_entries_no_update before update on public.treasury_entries
  for each row execute function public.treasury_immutable();
create trigger treasury_entries_no_delete before delete on public.treasury_entries
  for each row execute function public.treasury_immutable();
create trigger treasury_entries_no_truncate before truncate on public.treasury_entries
  for each statement execute function public.treasury_immutable();

create function public.treasury_funds_guard()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'treasury funds cannot be deleted' using errcode = '42501';
  end if;
  new.id := old.id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  return new;
end;
$$;
revoke all on function public.treasury_funds_guard() from public, anon, authenticated;
create trigger treasury_funds_no_delete before delete on public.treasury_funds
  for each row execute function public.treasury_funds_guard();
create trigger treasury_funds_keep_identity before update on public.treasury_funds
  for each row execute function public.treasury_funds_guard();

------------------------------------------------------------------------------
-- Balances (derived) and the no-negative rule
------------------------------------------------------------------------------

create function public.treasury_member_balance_raw(p_member uuid)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(case when to_member = p_member then amount_cents else 0 end), 0)
       - coalesce(sum(case when from_member = p_member then amount_cents else 0 end), 0)
  from public.treasury_entries
  where to_member = p_member or from_member = p_member;
$$;

create function public.treasury_fund_balance_raw(p_fund uuid)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(case when to_fund = p_fund then amount_cents else 0 end), 0)
       - coalesce(sum(case when from_fund = p_fund then amount_cents else 0 end), 0)
  from public.treasury_entries
  where to_fund = p_fund or from_fund = p_fund;
$$;

revoke all on function public.treasury_member_balance_raw(uuid) from public, anon, authenticated;
revoke all on function public.treasury_fund_balance_raw(uuid) from public, anon, authenticated;

-- Rejects an entry that would take its source bucket below zero. One lock serialises ledger writes,
-- so two concurrent entries cannot both spend the same cents.
create function public.treasury_entries_check()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('treasury_ledger'));
  if new.from_kind = 'member' and public.treasury_member_balance_raw(new.from_member) < new.amount_cents then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;
  if new.from_kind = 'fund' and public.treasury_fund_balance_raw(new.from_fund) < new.amount_cents then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.treasury_entries_check() from public, anon, authenticated;
create trigger treasury_entries_balance_check before insert on public.treasury_entries
  for each row execute function public.treasury_entries_check();

------------------------------------------------------------------------------
-- RLS: read-only for clients; every write is an RPC
------------------------------------------------------------------------------

revoke all on public.treasury_settings, public.treasury_funds, public.treasury_entries from anon, authenticated;
grant select on public.treasury_funds, public.treasury_entries to authenticated;
alter table public.treasury_settings enable row level security;
alter table public.treasury_funds enable row level security;
alter table public.treasury_entries enable row level security;
-- treasury_settings has no policy and no grant: read it through treasury_access() only.

create policy treasury_funds_select on public.treasury_funds
  for select to authenticated using (public.treasury_access() <> 'none');

-- Uses the row's own columns (a policy that looked the row up by id could not see an inserted row).
create policy treasury_entries_select on public.treasury_entries
  for select to authenticated using (
    public.treasury_access() = 'full'
    or (public.treasury_access() = 'own' and (from_member = auth.uid() or to_member = auth.uid()))
  );

------------------------------------------------------------------------------
-- Reads that return derived figures
------------------------------------------------------------------------------

-- The caller's own stored balance (cents). 0 when there is nothing, null when they have no access.
create function public.treasury_my_balance()
returns bigint
language sql stable security definer set search_path = ''
as $$
  select case when public.treasury_access() = 'none' then null
              else public.treasury_member_balance_raw(auth.uid()) end;
$$;

-- Every non-zero member balance and every fund (even at zero), for the 'full' audience only.
create function public.treasury_balances()
returns table (kind text, id uuid, name text, balance_cents bigint)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if public.treasury_access() <> 'full' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select 'fund'::text, f.id, f.name, public.treasury_fund_balance_raw(f.id)
    from public.treasury_funds f
    union all
    select 'member'::text, b.member, coalesce(p.callsign, 'Former member'), b.bal
    from (
      select m as member, public.treasury_member_balance_raw(m) as bal
      from (
        select from_member as m from public.treasury_entries where from_member is not null
        union
        select to_member from public.treasury_entries where to_member is not null
      ) ids
    ) b
    left join public.profiles p on p.id = b.member
    where b.bal <> 0
    order by 1, 3;
end;
$$;

-- The reconciliation proof: external in - external out = member balances + fund balances.
create function public.treasury_reconcile()
returns table (external_in bigint, external_out bigint, net_external bigint, member_total bigint, fund_total bigint, ok boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_in bigint; v_out bigint; v_mem bigint; v_fund bigint;
begin
  if public.treasury_access() <> 'full' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(sum(amount_cents) filter (where from_kind = 'external'), 0),
         coalesce(sum(amount_cents) filter (where to_kind = 'external'), 0)
    into v_in, v_out from public.treasury_entries;
  select coalesce(sum(case when to_kind = 'member' then amount_cents else 0 end)
                - sum(case when from_kind = 'member' then amount_cents else 0 end), 0),
         coalesce(sum(case when to_kind = 'fund' then amount_cents else 0 end)
                - sum(case when from_kind = 'fund' then amount_cents else 0 end), 0)
    into v_mem, v_fund from public.treasury_entries;
  return query select v_in, v_out, v_in - v_out, v_mem, v_fund, (v_in - v_out = v_mem + v_fund);
end;
$$;

revoke all on function public.treasury_my_balance() from public, anon;
revoke all on function public.treasury_balances() from public, anon;
revoke all on function public.treasury_reconcile() from public, anon;
grant execute on function public.treasury_my_balance() to authenticated;
grant execute on function public.treasury_balances() to authenticated;
grant execute on function public.treasury_reconcile() to authenticated;

------------------------------------------------------------------------------
-- Writes (Treasurer)
------------------------------------------------------------------------------

create function public.treasury_create_fund(p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.treasury_can_manage() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_name is null or length(btrim(p_name)) not between 2 and 60 then
    raise exception 'bad_name' using errcode = 'P0001';
  end if;
  begin
    insert into public.treasury_funds (name, created_by) values (btrim(p_name), auth.uid()) returning id into v_id;
  exception when unique_violation then
    raise exception 'name_taken' using errcode = 'P0001';
  end;
  insert into public.settings_audit (actor_id, event, target, detail)
  values (auth.uid(), 'treasury_fund_created', 'treasury', btrim(p_name));
  return v_id;
end;
$$;

create function public.treasury_rename_fund(p_fund uuid, p_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old text;
begin
  if not public.treasury_can_manage() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_name is null or length(btrim(p_name)) not between 2 and 60 then
    raise exception 'bad_name' using errcode = 'P0001';
  end if;
  select name into v_old from public.treasury_funds where id = p_fund;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  begin
    update public.treasury_funds set name = btrim(p_name), renamed_at = now() where id = p_fund;
  exception when unique_violation then
    raise exception 'name_taken' using errcode = 'P0001';
  end;
  insert into public.settings_audit (actor_id, event, target, detail)
  values (auth.uid(), 'treasury_fund_renamed', 'treasury', v_old || ' -> ' || btrim(p_name));
end;
$$;

-- One entry. from/to kind: 'external' (id ignored), 'member' or 'fund'. Date may not be in the future.
create function public.treasury_record(
  p_date date, p_amount_cents bigint,
  p_from_kind text, p_from_id uuid,
  p_to_kind text, p_to_id uuid,
  p_category text, p_note text default ''
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_me text;
  v_fc text;
  v_tc text;
begin
  if not public.treasury_can_manage() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_date is null or p_date > current_date + 1 or p_date < date '2000-01-01' then
    raise exception 'bad_date' using errcode = 'P0001';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 100000000 then
    raise exception 'bad_amount' using errcode = 'P0001';
  end if;
  if p_from_kind not in ('external', 'member', 'fund') or p_to_kind not in ('external', 'member', 'fund') then
    raise exception 'bad_bucket' using errcode = 'P0001';
  end if;
  if p_from_kind = 'external' and p_to_kind = 'external' then
    raise exception 'bad_bucket' using errcode = 'P0001';
  end if;
  if p_category is null or p_category !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'bad_category' using errcode = 'P0001';
  end if;
  if length(coalesce(p_note, '')) > 500 then
    raise exception 'bad_note' using errcode = 'P0001';
  end if;
  if p_from_kind = 'member' then
    select callsign into v_fc from public.profiles where id = p_from_id;
    if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  elsif p_from_kind = 'fund' then
    if not exists (select 1 from public.treasury_funds where id = p_from_id) then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
  end if;
  if p_to_kind = 'member' then
    select callsign into v_tc from public.profiles where id = p_to_id;
    if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  elsif p_to_kind = 'fund' then
    if not exists (select 1 from public.treasury_funds where id = p_to_id) then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
  end if;
  select callsign into v_me from public.profiles where id = auth.uid();

  insert into public.treasury_entries (
    entry_date, amount_cents,
    from_kind, from_member, from_fund, from_callsign,
    to_kind, to_member, to_fund, to_callsign,
    category, note, entered_by, entered_by_callsign
  ) values (
    p_date, p_amount_cents,
    p_from_kind, case when p_from_kind = 'member' then p_from_id end, case when p_from_kind = 'fund' then p_from_id end, v_fc,
    p_to_kind, case when p_to_kind = 'member' then p_to_id end, case when p_to_kind = 'fund' then p_to_id end, v_tc,
    p_category, coalesce(btrim(p_note), ''), auth.uid(), v_me
  ) returning id into v_id;
  return v_id;
end;
$$;

-- Reverses one entry with an opposite entry linked to it. The reversal is dated today.
create function public.treasury_reverse(p_entry uuid, p_note text default '')
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  e public.treasury_entries%rowtype;
  v_id uuid;
  v_me text;
begin
  if not public.treasury_can_manage() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into e from public.treasury_entries where id = p_entry;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if e.reverses is not null then
    raise exception 'is_reversal' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.treasury_entries where reverses = p_entry) then
    raise exception 'already_reversed' using errcode = 'P0001';
  end if;
  if p_note is null or length(btrim(p_note)) not between 3 and 500 then
    raise exception 'bad_note' using errcode = 'P0001';
  end if;
  select callsign into v_me from public.profiles where id = auth.uid();
  insert into public.treasury_entries (
    entry_date, amount_cents,
    from_kind, from_member, from_fund, from_callsign,
    to_kind, to_member, to_fund, to_callsign,
    category, note, reverses, entered_by, entered_by_callsign
  ) values (
    current_date, e.amount_cents,
    e.to_kind, e.to_member, e.to_fund, e.to_callsign,
    e.from_kind, e.from_member, e.from_fund, e.from_callsign,
    'reversal', btrim(p_note), e.id, auth.uid(), v_me
  ) returning id into v_id;
  return v_id;
end;
$$;

-- The go-live switch. Admin only, logged. Do not flip it until the go-live gate is met.
create function public.set_treasury_member_access(p_on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old boolean;
begin
  if not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'bad_value' using errcode = 'P0001';
  end if;
  select member_access into v_old from public.treasury_settings where singleton;
  if v_old = p_on then
    return;
  end if;
  update public.treasury_settings set member_access = p_on, updated_at = now(), updated_by = auth.uid() where singleton;
  insert into public.settings_audit (actor_id, event, target, detail)
  values (auth.uid(), 'treasury_member_access_changed', 'treasury', v_old::text || ' -> ' || p_on::text);
end;
$$;

revoke all on function public.treasury_create_fund(text) from public, anon;
revoke all on function public.treasury_rename_fund(uuid, text) from public, anon;
revoke all on function public.treasury_record(date, bigint, text, uuid, text, uuid, text, text) from public, anon;
revoke all on function public.treasury_reverse(uuid, text) from public, anon;
revoke all on function public.set_treasury_member_access(boolean) from public, anon;
grant execute on function public.treasury_create_fund(text) to authenticated;
grant execute on function public.treasury_rename_fund(uuid, text) to authenticated;
grant execute on function public.treasury_record(date, bigint, text, uuid, text, uuid, text, text) to authenticated;
grant execute on function public.treasury_reverse(uuid, text) to authenticated;
grant execute on function public.set_treasury_member_access(boolean) to authenticated;
