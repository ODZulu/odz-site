-- MVA-238: Retired status for members who stop playing without being removed.
--
--   * 'retired' is a profile STATUS, not a tier. Seats, tallies and readiness already count only
--     approved/suspended accounts, so a retired member frees an Old Guard / Command seat at once
--     (seat_tally, MVA-234), drops out of tier counts and event readiness, and holds no capability
--     (has_capability needs status = 'approved'). Their tier is left as it was and retired_from_tier
--     remembers it for the unretire step.
--   * Retired accounts keep a limited sign-in: their own profile row, Traffic and their own
--     notifications. Everything else stays denied by the existing 'approved' gates (event details,
--     minutes, documents, member_private of others, RSVPs). The service record stays intact: it is
--     keyed on the profile and its owner can read it.
--   * retire_member() / unretire_member() are SECURITY DEFINER RPCs needing edit_roster (Command;
--     Admin passes every check). Retiring vacates the member's designations and office seats and
--     logs each in designation_audit; they are NOT restored on return. Unretire puts the account
--     back as approved in its prior tier, or in a tier Command picks; the existing seat-cap
--     trigger refuses a full seat. Every retire/unretire is a profile_audit row (who, when, tier,
--     reason).
--   * Retired members are readable in the roster (public fields) by approved members, so the UI
--     can list them in a separate Retired section that is not part of the active count.
--
-- Additive only: one status value, two nullable columns, two audit event names, new functions, two
-- replaced policies and one replaced trigger function. No existing row is rewritten.
-- Replaced from their newest definition: profiles_guard (20261013220000_support_tier.sql),
-- traffic_select (20261011180000_hq_panels.sql) and profiles_select_roster
-- (20261010181521_db_foundation.sql).

------------------------------------------------------------------------------
-- Status, columns, audit events
------------------------------------------------------------------------------

alter table public.profiles drop constraint profiles_status_check;
alter table public.profiles
  add constraint profiles_status_check check (status in ('pending', 'approved', 'suspended', 'removed', 'retired'));

alter table public.profiles add column retired_at timestamptz;
-- Deliberately NOT a foreign key to tiers: a second profiles -> tiers relationship would make every
-- PostgREST embed such as tier:tiers(name,rank) ambiguous. unretire_member() checks the tier exists.
alter table public.profiles add column retired_from_tier uuid;

alter table public.profile_audit drop constraint profile_audit_event_check;
alter table public.profile_audit
  add constraint profile_audit_event_check
  check (event in ('status', 'tier', 'admin', 'private', 'profile', 'retired', 'unretired'));

------------------------------------------------------------------------------
-- Helper: the caller is a retired member
------------------------------------------------------------------------------

create function public.current_user_is_retired()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.status = 'retired'
  );
$$;

revoke all on function public.current_user_is_retired() from public, anon;
grant execute on function public.current_user_is_retired() to authenticated;

------------------------------------------------------------------------------
-- Limited access for Retired: Traffic read, and the public roster fields (author names)
------------------------------------------------------------------------------

drop policy traffic_select on public.traffic;
create policy traffic_select on public.traffic
  for select to authenticated
  using (
    (archived_at is null and (public.current_user_is_approved() or public.current_user_is_retired()))
    or public.has_capability('write_traffic')
  );

drop policy profiles_select_roster on public.profiles;
create policy profiles_select_roster on public.profiles
  for select to authenticated
  using (
    status in ('approved', 'retired')
    and (public.current_user_is_approved() or public.current_user_is_retired())
  );

------------------------------------------------------------------------------
-- Guard
------------------------------------------------------------------------------
-- Copied from 20261013220000_support_tier.sql (newest definition), plus two changes:
--   1. odz.member_rpc = 'reinstate' lets reinstate_member() (MVA-249) bring a removed account back.
--   2. odz.member_rpc in (retire, unretire, reinstate) skips the approve_members check on a status
--      change: those RPCs do their own capability check first. Every other guard rule (own status,
--      admin profiles, last admin, tier entry rules) still applies to them.
-- The setting is transaction-local and set only inside those functions.

create or replace function public.profiles_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  old_tier public.tiers;
  new_tier public.tiers;
begin
  if tg_op = 'DELETE' then
    if old.is_admin and old.status = 'approved' then
      perform 1 from public.profiles p
        where p.id <> old.id and p.is_admin and p.status = 'approved'
        for update;
      if not found then
        raise exception 'cannot remove the last admin' using errcode = 'P0001';
      end if;
    end if;
    return old;
  end if;

  if new.id <> old.id then
    raise exception 'profile id cannot be changed' using errcode = '42501';
  end if;

  -- Removed accounts cannot be edited or reinstated by a signed-in caller. Re-onboarding is a
  -- fresh invite. (Callers with no JWT, such as the SQL editor, stay trusted as elsewhere.)
  if old.status = 'removed' and auth.uid() is not null
     and coalesce(current_setting('odz.member_rpc', true), '') <> 'reinstate' then
    raise exception 'account was removed' using errcode = '42501';
  end if;
  if new.status = 'removed' and old.status <> 'removed'
     and coalesce(current_setting('odz.member_removal', true), '') <> 'on' then
    raise exception 'use remove_member' using errcode = '42501';
  end if;

  if old.is_admin and old.status = 'approved' and (not new.is_admin or new.status <> 'approved') then
    perform 1 from public.profiles p
      where p.id <> old.id and p.is_admin and p.status = 'approved'
      for update;
    if not found then
      raise exception 'cannot demote or suspend the last admin' using errcode = 'P0001';
    end if;
  end if;

  if new.tier_id is distinct from old.tier_id then
    if old.tier_id is not null then
      select * into old_tier from public.tiers where id = old.tier_id;
      if old_tier.release_to_tier_id is not null then
        new.tier_id := old_tier.release_to_tier_id;
      end if;
    end if;

    if new.tier_id is not null and new.tier_id is distinct from old.tier_id then
      select * into new_tier from public.tiers where id = new.tier_id;
      if new_tier.entry_requires_tier_id is not null
         and old.tier_id is distinct from new_tier.entry_requires_tier_id then
        raise exception 'tier % requires holding its prerequisite tier first', new_tier.name
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  if auth.uid() is not null then
    if new.is_admin is distinct from old.is_admin and not public.current_user_is_admin() then
      raise exception 'only admins can change is_admin' using errcode = '42501';
    end if;

    if new.tier_id is distinct from old.tier_id and old.id = auth.uid() then
      raise exception 'cannot change your own tier' using errcode = '42501';
    end if;

    if new.status is distinct from old.status and not public.has_capability('approve_members')
       and coalesce(current_setting('odz.member_rpc', true), '') not in ('retire', 'unretire', 'reinstate') then
      raise exception 'not allowed to change status' using errcode = '42501';
    end if;

    if new.tier_id is distinct from old.tier_id
       and not public.has_capability('edit_roster')
       and not (
         old.status = 'pending' and new.status = 'approved' and public.has_capability('approve_members')
       ) then
      raise exception 'not allowed to change tier' using errcode = '42501';
    end if;

    -- Moving between the player tiers and a role-based tier needs a logged note: RPC only.
    if new.tier_id is distinct from old.tier_id
       and coalesce((select t.role_based from public.tiers t where t.id = old.tier_id), false)
           is distinct from coalesce((select t.role_based from public.tiers t where t.id = new.tier_id), false)
       and coalesce(current_setting('odz.tier_move', true), '') <> 'on' then
      raise exception 'use move_support_tier' using errcode = '42501';
    end if;

    if (new.status is distinct from old.status or new.tier_id is distinct from old.tier_id)
       and not public.current_user_is_admin() then
      if old.id = auth.uid() then
        raise exception 'cannot change your own status or tier' using errcode = '42501';
      end if;
      if old.is_admin then
        raise exception 'only admins can change an admin profile' using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$$;
------------------------------------------------------------------------------
-- retire_member(profile, reason): Command / Admin action
------------------------------------------------------------------------------
-- Fixed error codes. The reason is optional (up to 300 characters). Only approved or suspended
-- accounts can be retired. Returns the names of the designations that were vacated.

create function public.retire_member(p_profile uuid, p_reason text default null)
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  target public.profiles;
  v_tier_name text;
  v_vacated text[];
begin
  if auth.uid() is null or not public.has_capability('edit_roster') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_reason is not null and length(v_reason) > 300 then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;
  if p_profile = auth.uid() then
    raise exception 'cannot_retire_self' using errcode = 'P0001';
  end if;

  select * into target from public.profiles where id = p_profile for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if target.status not in ('approved', 'suspended') then
    raise exception 'not_active' using errcode = 'P0001';
  end if;
  if target.is_admin and not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select t.name into v_tier_name from public.tiers t where t.id = target.tier_id;

  -- Designations and office seats are vacated, each one logged.
  select coalesce(array_agg(d.name order by d.name), '{}') into v_vacated
  from public.member_designations md join public.designations d on d.id = md.designation_id
  where md.profile_id = p_profile;
  insert into public.designation_audit (profile_id, callsign, designation_name, action, actor_id)
  select p_profile, target.callsign, d.name, 'revoked', auth.uid()
  from public.member_designations md join public.designations d on d.id = md.designation_id
  where md.profile_id = p_profile;
  delete from public.member_designations where profile_id = p_profile;

  perform set_config('odz.member_rpc', 'retire', true);
  update public.profiles
     set status = 'retired', retired_at = now(), retired_from_tier = target.tier_id
   where id = p_profile;
  perform set_config('odz.member_rpc', '', true);

  insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value, note)
  values (p_profile, auth.uid(), 'retired', v_tier_name, 'Retired', v_reason);

  return v_vacated;
end;
$$;

------------------------------------------------------------------------------
-- unretire_member(profile, tier): Command / Admin action
------------------------------------------------------------------------------
-- p_tier null restores the tier remembered at retirement. If that tier's seat is full the
-- seat-cap trigger refuses with "Old Guard is full: n/n" (or Command), and Command can call again
-- with a tier that has room. Designations are not restored.

create function public.unretire_member(p_profile uuid, p_tier uuid default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.profiles;
  v_tier uuid;
  v_tier_name text;
begin
  if auth.uid() is null or not public.has_capability('edit_roster') then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select * into target from public.profiles where id = p_profile for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if target.status <> 'retired' then
    raise exception 'not_retired' using errcode = 'P0001';
  end if;

  v_tier := coalesce(p_tier, target.retired_from_tier, target.tier_id);
  select t.name into v_tier_name from public.tiers t where t.id = v_tier;
  if v_tier_name is null then
    raise exception 'invalid_tier' using errcode = 'P0001';
  end if;

  perform set_config('odz.member_rpc', 'unretire', true);
  update public.profiles
     set status = 'approved', tier_id = v_tier, retired_at = null, retired_from_tier = null
   where id = p_profile;
  perform set_config('odz.member_rpc', '', true);

  insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value)
  values (p_profile, auth.uid(), 'unretired', 'Retired', v_tier_name);
end;
$$;

revoke all on function public.retire_member(uuid, text) from public, anon;
revoke all on function public.unretire_member(uuid, uuid) from public, anon;
grant execute on function public.retire_member(uuid, text) to authenticated;
grant execute on function public.unretire_member(uuid, uuid) to authenticated;
