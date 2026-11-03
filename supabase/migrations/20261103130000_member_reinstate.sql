-- MVA-249: reinstate a soft-removed member (the opposite of MVA-209 remove_member).
--
--   * reinstate_member(profile, reason) is an Admin-only SECURITY DEFINER RPC (mirrors removal; no
--     new capability). It works only on a SOFT-removed profile: a hard-deleted one has no row, an
--     active, retired, pending or suspended one is refused with `not_reinstatable`.
--   * Sign-in is restored by reversing exactly what remove_member did to it: auth.users.banned_until
--     (set to now() + 100 years) goes back to null. Sessions were deleted at removal, so the member
--     signs in fresh on the next attempt. Email and password are unchanged.
--   * The profile returns as `approved`, removed_at / removed_by cleared, `setup_complete = false`
--     (removal purged member_private, so first-login setup runs again). Tier: the previous tier,
--     EXCEPT a seat tier (Old Guard, Command; tiers.seat_group) returns as Member, so reinstatement
--     is never a back door around the seat caps (MVA-234); the seat-cap trigger still runs as well.
--   * Not restored: designations (cleared and logged in designation_audit; reassign through MVA-220
--     rules), private data, revoked invites.
--     Service history and DOE were never deleted, so they are visible again. Past authorship that
--     showed "Former member" shows the callsign again (the profile row never left).
--   * Audit: profile_audit event `member_reinstated` (who, whom, when, reason in `note`, previous
--     tier, resulting tier). The reason is the Admin's free text; no private values are written.
--
-- profiles_guard() is replaced from 20261103120000_retired_status.sql (the newest definition) with
-- ONE change: under odz.member_rpc = 'reinstate' the tier release rule and the tier entry
-- prerequisite are skipped. Without it, a removed Command member returned as Member would be
-- rewritten to Old Guard by tiers.release_to_tier_id.
--
-- Additive: one audit event name, one replaced trigger function, one new function. No existing row
-- is rewritten.

alter table public.profile_audit drop constraint profile_audit_event_check;
alter table public.profile_audit
  add constraint profile_audit_event_check
  check (event in ('status', 'tier', 'admin', 'private', 'profile', 'retired', 'unretired', 'member_reinstated'));

------------------------------------------------------------------------------
-- Guard
------------------------------------------------------------------------------

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

  -- reinstate_member() returns a seat tier's holder as Member on purpose: skip the release and
  -- entry rules for it (MVA-249).
  if new.tier_id is distinct from old.tier_id
     and coalesce(current_setting('odz.member_rpc', true), '') <> 'reinstate' then
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
-- reinstate_member(profile, reason): Admin only
------------------------------------------------------------------------------
-- Fixed error codes: `not allowed` (not an Admin), `invalid_reason` (3 to 500 characters),
-- `not_found`, `not_reinstatable`. Returns the name of the tier the member came back in.

create function public.reinstate_member(p_profile uuid, p_reason text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  target public.profiles;
  t_prev public.tiers;
  v_tier uuid;
  v_prev_name text;
  v_new_name text;
begin
  if auth.uid() is null or not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;

  select * into target from public.profiles where id = p_profile for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if target.status <> 'removed' or target.id = auth.uid() then
    raise exception 'not_reinstatable' using errcode = 'P0001';
  end if;

  select * into t_prev from public.tiers where id = target.tier_id;
  v_prev_name := t_prev.name;
  if t_prev.id is null then
    select id into v_tier from public.tiers where is_default_for_approval limit 1;
  elsif t_prev.seat_group is not null then
    -- Old Guard and Command seats come back only through the normal promotion path.
    select id into v_tier from public.tiers where name = 'Member';
    if v_tier is null then
      select id into v_tier from public.tiers where is_default_for_approval limit 1;
    end if;
  else
    v_tier := t_prev.id;
  end if;
  select name into v_new_name from public.tiers where id = v_tier;

  -- remove_member() left any designation rows in place (they were inert while the account was
  -- removed). They must not become live again: clear and log them; Command reassigns (MVA-220).
  insert into public.designation_audit (profile_id, callsign, designation_name, action, actor_id)
  select p_profile, target.callsign, d.name, 'revoked', auth.uid()
  from public.member_designations md join public.designations d on d.id = md.designation_id
  where md.profile_id = p_profile;
  delete from public.member_designations where profile_id = p_profile;

  perform set_config('odz.member_rpc', 'reinstate', true);
  update public.profiles
     set status = 'approved', tier_id = v_tier, removed_at = null, removed_by = null, setup_complete = false
   where id = p_profile;
  perform set_config('odz.member_rpc', '', true);

  -- Reverse the sign-in lock set by remove_member().
  update auth.users set banned_until = null where id = p_profile;

  insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value, note)
  values (p_profile, auth.uid(), 'member_reinstated', v_prev_name, v_new_name, v_reason);

  return v_new_name;
end;
$$;

revoke all on function public.reinstate_member(uuid, text) from public, anon;
grant execute on function public.reinstate_member(uuid, text) to authenticated;
