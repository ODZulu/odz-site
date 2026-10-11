-- MVA-199 (spec v2): invite-only signup, first-login account setup, private member data,
-- minimal approval RPCs.
--
-- Model:
--   * Signup needs a one-time invite code. The code travels in the signup metadata
--     (`invite_code`) and is consumed by the signup trigger in the same transaction that creates
--     the auth user, so a direct call to the Auth API without a valid code fails too.
--     (Consequence: users cannot be created from the Supabase dashboard without an invite either.
--     Make an invite with supabase/seed/first_invite.sql and sign up with it.)
--   * `check_invite()` is the only thing anon can call; it answers true/false and rate-limits
--     failed guesses (5 per source per 15 minutes, 50 overall). One generic answer for every kind
--     of invalid code.
--   * Sensitive personal data lives in `member_private`, never on `profiles`. Readable by the
--     owner and by holders of `view_member_private` (Command by default; the admin flag also
--     passes has_capability). Writes are audited by field name only, never by value.
--   * Audit log reads of private data are not logged (spec D).

------------------------------------------------------------------------------
-- profiles: setup flag, callsign format
------------------------------------------------------------------------------

alter table public.profiles
  add column setup_complete boolean not null default false,
  add constraint profiles_callsign_format
    check (callsign is null or callsign ~ '^[A-Za-z0-9 _-]{2,24}$');

-- setup_complete is intentionally NOT in the column grant for updates: only complete_setup()
-- (security definer) sets it.

------------------------------------------------------------------------------
-- Capability
------------------------------------------------------------------------------

insert into public.capabilities (key, description) values
  ('view_member_private', 'Read members'' private details (legal name, date of birth, phone, allergies, emergency contact)');

insert into public.tier_capabilities (tier_id, capability_key)
select t.id, 'view_member_private' from public.tiers t where t.name = 'Command';

------------------------------------------------------------------------------
-- Audit: allow a 'private' event (field names only)
------------------------------------------------------------------------------

alter table public.profile_audit drop constraint profile_audit_event_check;
alter table public.profile_audit
  add constraint profile_audit_event_check check (event in ('status', 'tier', 'admin', 'private'));

------------------------------------------------------------------------------
-- Invites
------------------------------------------------------------------------------

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (length(code) >= 10 and code = lower(code)),
  tier_id uuid not null references public.tiers (id),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz,
  revoked_at timestamptz,
  note text check (note is null or length(note) <= 200)
);

create function public.normalize_invite_code(p text)
returns text
language sql immutable set search_path = ''
as $$ select lower(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

-- Server-side code generation (clients cannot supply `code`: no insert grant on it) and the
-- allowed tiers: Recruit (default), Prospect, Contractor.
create function public.invites_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  tier_name text;
begin
  if new.code is null then
    new.code := substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 20);
  end if;
  if new.tier_id is null then
    select id into new.tier_id from public.tiers where name = 'Recruit';
  end if;
  select name into tier_name from public.tiers where id = new.tier_id;
  if tier_name is null or tier_name not in ('Recruit', 'Prospect', 'Contractor') then
    raise exception 'invites can only grant Recruit, Prospect or Contractor' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger invites_prepare
  before insert on public.invites
  for each row execute function public.invites_prepare();

-- Revocation is one-way and only for unused invites.
create function public.invites_guard()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.revoked_at is distinct from old.revoked_at then
    if old.revoked_at is not null or old.used_at is not null then
      raise exception 'invite is already used or revoked' using errcode = 'P0001';
    end if;
    new.revoked_at := now();
  end if;
  return new;
end;
$$;

create trigger invites_guard
  before update on public.invites
  for each row execute function public.invites_guard();

-- Who issued, used and revoked each invite (never the code itself).
create table public.invite_audit (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null,            -- no FK on purpose: the log outlives the invite
  actor_id uuid,
  event text not null check (event in ('created', 'used', 'revoked')),
  created_at timestamptz not null default now()
);

create function public.invites_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.invite_audit (invite_id, actor_id, event) values (new.id, new.created_by, 'created');
  else
    if new.used_at is distinct from old.used_at and new.used_at is not null then
      insert into public.invite_audit (invite_id, actor_id, event) values (new.id, new.used_by, 'used');
    end if;
    if new.revoked_at is distinct from old.revoked_at and new.revoked_at is not null then
      insert into public.invite_audit (invite_id, actor_id, event) values (new.id, auth.uid(), 'revoked');
    end if;
  end if;
  return null;
end;
$$;

create trigger invites_audit
  after insert or update on public.invites
  for each row execute function public.invites_audit();

-- Failed-guess counters for check_invite(). No policies and no grants: only the definer function
-- touches it.
create table public.invite_attempts (
  key text primary key,
  failures integer not null default 0,
  last_failure timestamptz,
  locked_until timestamptz
);

------------------------------------------------------------------------------
-- Invite functions
------------------------------------------------------------------------------

-- Public pre-check for the join page. True only for a valid code; false for everything else
-- (unknown, used, revoked, expired, locked out). Does not consume the invite.
create function public.check_invite(p_code text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_code text := public.normalize_invite_code(p_code);
  hdr json;
  ip text;
  k text;
  lim integer;
begin
  begin
    hdr := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    hdr := null;
  end;
  ip := coalesce(
    nullif(hdr ->> 'cf-connecting-ip', ''),
    nullif(hdr ->> 'x-real-ip', ''),
    nullif(btrim(split_part(coalesce(hdr ->> 'x-forwarded-for', ''), ',', 1)), ''),
    'unknown'
  );

  if exists (
    select 1 from public.invite_attempts a
    where a.key in ('ip:' || ip, 'all') and a.locked_until > now()
  ) then
    return false;
  end if;

  if exists (
    select 1 from public.invites i
    where i.code = v_code and i.used_at is null and i.revoked_at is null and i.expires_at > now()
  ) then
    return true;
  end if;

  foreach k in array array['ip:' || ip, 'all'] loop
    lim := case when k = 'all' then 50 else 5 end;
    insert into public.invite_attempts as a (key, failures, last_failure)
    values (k, 1, now())
    on conflict (key) do update set
      failures = case when a.last_failure < now() - interval '15 minutes' then 1 else a.failures + 1 end,
      last_failure = now();
    update public.invite_attempts a
       set locked_until = now() + interval '15 minutes', failures = 0
     where a.key = k and a.failures >= lim;
  end loop;

  return false;
end;
$$;

-- Validates and consumes an invite atomically (row lock = single use). Called by the signup
-- trigger only; nobody can execute it directly. Returns the tier the invite grants.
create function public.redeem_invite(p_code text, p_user uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  inv public.invites;
begin
  select * into inv from public.invites i
   where i.code = public.normalize_invite_code(p_code)
     and i.used_at is null and i.revoked_at is null and i.expires_at > now()
   for update;
  if not found then
    raise exception 'Invite not valid' using errcode = 'P0001';
  end if;
  update public.invites set used_by = p_user, used_at = now() where id = inv.id;
  return inv.tier_id;
end;
$$;

-- Signup: no valid invite, no account.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_tier uuid;
begin
  v_tier := public.redeem_invite(new.raw_user_meta_data ->> 'invite_code', new.id);
  insert into public.profiles (id, tier_id) values (new.id, v_tier);
  return new;
end;
$$;

revoke all on function public.normalize_invite_code(text) from public, anon, authenticated;
revoke all on function public.invites_prepare() from public, anon, authenticated;
revoke all on function public.invites_guard() from public, anon, authenticated;
revoke all on function public.invites_audit() from public, anon, authenticated;
revoke all on function public.redeem_invite(text, uuid) from public, anon, authenticated;
revoke all on function public.check_invite(text) from public, anon, authenticated;
grant execute on function public.check_invite(text) to anon, authenticated;

------------------------------------------------------------------------------
-- Private member data
------------------------------------------------------------------------------

create table public.member_private (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  legal_name text not null check (length(btrim(legal_name)) between 1 and 100),
  dob date not null check (dob >= date '1900-01-01'),
  phone text check (phone is null or phone ~ '^\+?[0-9 ().-]{7,20}$'),
  allergies text not null check (length(btrim(allergies)) between 1 and 500),
  emergency_name text not null check (length(btrim(emergency_name)) between 1 and 100),
  emergency_relationship text not null check (length(btrim(emergency_relationship)) between 1 and 50),
  emergency_phone text not null check (emergency_phone ~ '^\+?[0-9 ().-]{7,20}$'),
  updated_at timestamptz not null default now()
);

create function public.member_private_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.dob > current_date then
    raise exception 'invalid_dob' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger member_private_prepare
  before insert or update on public.member_private
  for each row execute function public.member_private_prepare();

-- Every write is logged with the names of the fields touched, never the values.
create function public.member_private_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  fields text;
begin
  select string_agg(n.key, ',' order by n.key) into fields
  from jsonb_each(to_jsonb(new)) n
  left join jsonb_each(case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end) o using (key)
  where n.key not in ('profile_id', 'updated_at')
    and n.value is distinct from o.value;

  if fields is not null then
    insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value)
    values (new.profile_id, auth.uid(), 'private', null, fields);
  end if;
  return null;
end;
$$;

create trigger member_private_audit
  after insert or update on public.member_private
  for each row execute function public.member_private_audit();

revoke all on function public.member_private_prepare() from public, anon, authenticated;
revoke all on function public.member_private_audit() from public, anon, authenticated;

------------------------------------------------------------------------------
-- First-login account setup (one call, atomic)
------------------------------------------------------------------------------
-- Errors carry only a fixed code ("invalid_dob", "callsign_taken", ...), never the submitted
-- values, so nothing sensitive can leak through an error message.

create function public.complete_setup(
  p_callsign text,
  p_legal_name text,
  p_dob date,
  p_phone text,
  p_allergies text,
  p_emergency_name text,
  p_emergency_relationship text,
  p_emergency_phone text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  prof public.profiles;
  v_callsign text := btrim(p_callsign);
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_ephone text := btrim(coalesce(p_emergency_phone, ''));
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into prof from public.profiles where id = uid;
  if not found or prof.status = 'suspended' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if prof.setup_complete then
    raise exception 'setup_already_complete' using errcode = 'P0001';
  end if;

  if v_callsign is null or v_callsign !~ '^[A-Za-z0-9 _-]{2,24}$' then
    raise exception 'invalid_callsign' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles p where lower(p.callsign) = lower(v_callsign) and p.id <> uid) then
    raise exception 'callsign_taken' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_legal_name, ''))) not between 1 and 100 then
    raise exception 'invalid_legal_name' using errcode = 'P0001';
  end if;
  if p_dob is null or p_dob < date '1900-01-01' or p_dob > current_date then
    raise exception 'invalid_dob' using errcode = 'P0001';
  end if;
  if v_phone is not null and (v_phone !~ '^\+?[0-9 ().-]{7,20}$'
     or length(regexp_replace(v_phone, '\D', '', 'g')) not between 7 and 15) then
    raise exception 'invalid_phone' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_allergies, ''))) not between 1 and 500 then
    raise exception 'invalid_allergies' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_emergency_name, ''))) not between 1 and 100 then
    raise exception 'invalid_emergency_name' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_emergency_relationship, ''))) not between 1 and 50 then
    raise exception 'invalid_emergency_relationship' using errcode = 'P0001';
  end if;
  if v_ephone !~ '^\+?[0-9 ().-]{7,20}$'
     or length(regexp_replace(v_ephone, '\D', '', 'g')) not between 7 and 15 then
    raise exception 'invalid_emergency_phone' using errcode = 'P0001';
  end if;

  insert into public.member_private
    (profile_id, legal_name, dob, phone, allergies, emergency_name, emergency_relationship, emergency_phone)
  values
    (uid, btrim(p_legal_name), p_dob, v_phone, btrim(p_allergies), btrim(p_emergency_name),
     btrim(p_emergency_relationship), v_ephone)
  on conflict (profile_id) do update set
    legal_name = excluded.legal_name, dob = excluded.dob, phone = excluded.phone,
    allergies = excluded.allergies, emergency_name = excluded.emergency_name,
    emergency_relationship = excluded.emergency_relationship, emergency_phone = excluded.emergency_phone;

  update public.profiles set callsign = v_callsign, setup_complete = true where id = uid;
end;
$$;

------------------------------------------------------------------------------
-- Approval RPCs (minimum; the queue UI is MVA-141)
------------------------------------------------------------------------------
-- The profiles guard trigger still applies (no self-approval for non-admins, admin targets, etc.)
-- and the audit trigger records the actor. Approval keeps the tier the invite granted.

create function public.approve_member(p_profile uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_capability('approve_members') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.profiles set status = 'approved'
   where id = p_profile and status = 'pending' and setup_complete;
  if not found then
    raise exception 'not pending, or account setup is not complete' using errcode = 'P0001';
  end if;
end;
$$;

create function public.reject_member(p_profile uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_capability('approve_members') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.profiles set status = 'suspended' where id = p_profile and status = 'pending';
  if not found then
    raise exception 'not pending' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.complete_setup(text, text, date, text, text, text, text, text) from public, anon;
revoke all on function public.approve_member(uuid) from public, anon;
revoke all on function public.reject_member(uuid) from public, anon;
grant execute on function public.complete_setup(text, text, date, text, text, text, text, text) to authenticated;
grant execute on function public.approve_member(uuid) to authenticated;
grant execute on function public.reject_member(uuid) to authenticated;

------------------------------------------------------------------------------
-- Grants and RLS
------------------------------------------------------------------------------

revoke all on public.invites, public.invite_audit, public.invite_attempts, public.member_private
  from anon, authenticated;

-- invites: Command/Admin (approve_members) issue, read and revoke. `code` is server-generated,
-- so it is not in the insert grant; only revoked_at can be updated.
grant select on public.invites to authenticated;
grant insert (tier_id, note) on public.invites to authenticated;
grant update (revoked_at) on public.invites to authenticated;
grant select on public.invite_audit to authenticated;

alter table public.invites enable row level security;
alter table public.invite_audit enable row level security;
alter table public.invite_attempts enable row level security;
alter table public.member_private enable row level security;

create policy invites_select on public.invites
  for select to authenticated using (public.has_capability('approve_members'));
create policy invites_insert on public.invites
  for insert to authenticated with check (public.has_capability('approve_members'));
create policy invites_update on public.invites
  for update to authenticated
  using (public.has_capability('approve_members'))
  with check (public.has_capability('approve_members'));

create policy invite_audit_select on public.invite_audit
  for select to authenticated using (public.has_capability('approve_members'));

-- invite_attempts: RLS on, no policies, no grants.

-- member_private: the owner and view_member_private holders read; the owner writes; only
-- admins delete.
grant select, insert, update, delete on public.member_private to authenticated;

create policy member_private_select_own on public.member_private
  for select to authenticated using (profile_id = (select auth.uid()));
create policy member_private_select_privileged on public.member_private
  for select to authenticated using (public.has_capability('view_member_private'));
create policy member_private_insert_own on public.member_private
  for insert to authenticated with check (profile_id = (select auth.uid()));
create policy member_private_update_own on public.member_private
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));
create policy member_private_delete_admin on public.member_private
  for delete to authenticated using (public.current_user_is_admin());
