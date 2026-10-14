-- MVA-237: Support tier for non-playing team members (Dax ruling, 2026-10-13).
--
--   * Support is a role-based tier outside the player progression. It is data, not a name check:
--     tiers.role_based marks it, so renaming the tier never breaks the rules.
--   * It has no capabilities at all (the other tiers' grants are untouched). Traffic is readable by
--     any approved account, so Support reads Traffic with no grant. It cannot read event details,
--     minutes, documents, member_private (other than its own row, if it has one) or RSVP data.
--   * It is excluded from player counts because counts_for_readiness stays false; the readiness
--     meter, RSVP totals and the HQ readiness view already filter on that column. It cannot RSVP
--     because RSVPs need read_event_details.
--   * Moving an account across the player/Support line is a Command action (edit_roster) through
--     move_support_tier(), with a required note that is logged in profile_audit. Direct updates
--     that cross the line are refused for signed-in callers. Command and Old Guard are barred on
--     both sides of a move (tiers.support_barred): nobody goes Support <-> Command/Old Guard
--     directly, so Support can never hold a seat that carries authority.
--   * Invites may grant Support (invitable). The default tier for an invite with no tier named
--     stays the least senior PLAYER tier (Recruit), never a role-based one.
--   * First-login setup for Support collects only the callsign (complete_support_setup). Moving a
--     Support account into the player pipeline sends it back through the full setup once, so the
--     private details players must hold are collected before it counts anywhere.
--
-- Additive only: two columns on tiers, one on profile_audit, one new tier row, new functions, and
-- replaced functions. No existing row is rewritten except the two flags set on Command and Old Guard.
-- Office-seat rejection for Support (the designations half of the AC) lands with MVA-220, which
-- creates the seats; it reads tiers.role_based.

------------------------------------------------------------------------------
-- Tier flags and the Support tier
------------------------------------------------------------------------------

alter table public.tiers
  add column role_based boolean not null default false,
  add column support_barred boolean not null default false;

update public.tiers set support_barred = true where name in ('Command', 'Old Guard');

-- Last in the ladder for display (it is not a seniority rank). No capabilities are granted.
insert into public.tiers (name, rank, invitable, counts_for_readiness, role_based)
values ('Support', (select coalesce(max(rank), 0) + 1 from public.tiers), true, false, true);

------------------------------------------------------------------------------
-- Invites: the default tier is the least senior player tier
------------------------------------------------------------------------------

-- Copied from 20261011140000_admin_settings.sql (newest definition), with the "not role_based" default.
create or replace function public.invites_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  ok boolean;
begin
  if new.code is null then
    new.code := substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 20);
  end if;
  new.code_hint := right(new.code, 4);
  if new.tier_id is null then
    -- The least senior player tier that invites may grant (Recruit in the seed).
    select id into new.tier_id from public.tiers where invitable and not role_based order by rank desc limit 1;
  end if;
  select invitable into ok from public.tiers where id = new.tier_id;
  if ok is not true then
    raise exception 'invites cannot grant that tier' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

------------------------------------------------------------------------------
-- Audit: tier moves carry a note
------------------------------------------------------------------------------

alter table public.profile_audit add column note text;

-- Copied from 20261011160000_profiles_directory.sql (the newest definition; 20261013190000 does
-- not redefine it), plus the tier note on the 'tier' insert.
create or replace function public.profiles_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  fields text;
begin
  if new.status is distinct from old.status then
    insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value)
    values (new.id, auth.uid(), 'status', old.status, new.status);
  end if;

  if new.tier_id is distinct from old.tier_id then
    insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value, note)
    values (
      new.id, auth.uid(), 'tier',
      (select t.name from public.tiers t where t.id = old.tier_id),
      (select t.name from public.tiers t where t.id = new.tier_id),
      nullif(current_setting('odz.tier_note', true), '')
    );
  end if;

  if new.is_admin is distinct from old.is_admin then
    insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value)
    values (new.id, auth.uid(), 'admin', old.is_admin::text, new.is_admin::text);
  end if;

  select string_agg(f.name, ',' order by f.name) into fields
  from (values
    ('callsign', new.callsign is distinct from old.callsign),
    ('display_name', new.display_name is distinct from old.display_name),
    ('role_note', new.role_note is distinct from old.role_note),
    ('bio', new.bio is distinct from old.bio)
  ) as f(name, changed)
  where f.changed;
  -- Setting the callsign during first-login setup is not an edit.
  if fields is not null and not (old.setup_complete is false and new.setup_complete is true) then
    insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value)
    values (new.id, auth.uid(), 'profile', null, fields);
  end if;

  return null;
end;
$$;

-- Copied from 20261013190000_member_removal.sql (newest definition), plus the tier-note suffix on tier rows.
create or replace function public.list_audit(p_limit integer default 25, p_offset integer default 0)
returns table (at timestamptz, actor text, kind text, event text, target text, detail text, total bigint)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (public.has_capability('approve_members') or public.has_capability('edit_roster')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  p_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);
  return query
    with feed as (
      select a.created_at as at,
             (select p.callsign from public.profiles p where p.id = a.actor_id) as actor,
             'profile'::text as kind,
             a.event,
             (select p.callsign from public.profiles p where p.id = a.profile_id) as target,
             case when a.event in ('private', 'profile') then 'fields: ' || coalesce(a.new_value, '')
                  else coalesce(a.old_value, '-') || ' -> ' || coalesce(a.new_value, '-')
                       || case when a.note is not null then ' (' || a.note || ')' else '' end end as detail
      from public.profile_audit a
      union all
      select i.created_at,
             (select p.callsign from public.profiles p where p.id = i.actor_id),
             'invite'::text,
             i.event,
             'invite ...' || coalesce((select v.code_hint from public.invites v where v.id = i.invite_id), '(removed)'),
             null::text
      from public.invite_audit i
      union all
      select s.created_at,
             (select p.callsign from public.profiles p where p.id = s.actor_id),
             'settings'::text,
             s.event,
             s.target,
             s.detail
      from public.settings_audit s
      union all
      select r.created_at,
             (select p.callsign from public.profiles p where p.id = r.actor_id),
             'removal'::text,
             r.action,
             r.callsign,
             r.reason
      from public.member_removals r
      where public.current_user_is_admin()
    )
    select f.at, coalesce(f.actor, 'system'), f.kind, f.event, coalesce(f.target, '-'), f.detail,
           count(*) over ()
    from feed f
    order by f.at desc
    limit p_limit offset p_offset;
end;
$$;

------------------------------------------------------------------------------
-- Guard: crossing the player/Support line only through move_support_tier()
------------------------------------------------------------------------------
-- Copied from 20261013190000_member_removal.sql (newest definition), plus the role_based check inside the signed-in block.

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
  if old.status = 'removed' and auth.uid() is not null then
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

    if new.status is distinct from old.status and not public.has_capability('approve_members') then
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
-- move_support_tier(profile, tier, note): Command action across the Support line
------------------------------------------------------------------------------
-- Errors are fixed codes. Needs edit_roster (Command; Admin passes every check). The note (3 to
-- 300 characters) is stored on the profile_audit tier row. Support <-> Command/Old Guard is
-- refused in both directions. Moving a Support account into a player tier that has no private
-- details yet re-opens first-login setup, so those details are collected before it counts.

create function public.move_support_tier(p_profile uuid, p_tier uuid, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_note text := btrim(coalesce(p_note, ''));
  prof public.profiles;
  t_old public.tiers;
  t_new public.tiers;
begin
  if auth.uid() is null or not public.has_capability('edit_roster') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_note) < 3 or length(v_note) > 300 then
    raise exception 'invalid_note' using errcode = 'P0001';
  end if;

  select * into prof from public.profiles where id = p_profile for update;
  if not found or prof.status = 'removed' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into t_old from public.tiers where id = prof.tier_id;
  select * into t_new from public.tiers where id = p_tier;
  if not found or t_old.id is null then
    raise exception 'invalid_tier' using errcode = 'P0001';
  end if;
  if t_old.role_based = t_new.role_based then
    raise exception 'not_a_support_move' using errcode = 'P0001';
  end if;
  if t_old.support_barred or t_new.support_barred then
    raise exception 'tier_barred' using errcode = 'P0001';
  end if;

  perform set_config('odz.tier_move', 'on', true);
  perform set_config('odz.tier_note', v_note, true);
  update public.profiles set tier_id = p_tier where id = p_profile;
  if t_old.role_based and not exists (select 1 from public.member_private m where m.profile_id = p_profile) then
    update public.profiles set setup_complete = false where id = p_profile;
  end if;
  perform set_config('odz.tier_move', '', true);
  perform set_config('odz.tier_note', '', true);
end;
$$;

revoke all on function public.move_support_tier(uuid, uuid, text) from public, anon;
grant execute on function public.move_support_tier(uuid, uuid, text) to authenticated;

------------------------------------------------------------------------------
-- First-login setup for Support: callsign only
------------------------------------------------------------------------------

create function public.my_tier_is_role_based()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select t.role_based from public.profiles p join public.tiers t on t.id = p.tier_id where p.id = auth.uid()
  ), false);
$$;

revoke all on function public.my_tier_is_role_based() from public, anon;
grant execute on function public.my_tier_is_role_based() to authenticated;

create function public.complete_support_setup(p_callsign text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  prof public.profiles;
  v_callsign text := btrim(p_callsign);
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into prof from public.profiles where id = uid;
  if not found or prof.status not in ('pending', 'approved') or not public.my_tier_is_role_based() then
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
  update public.profiles set callsign = v_callsign, setup_complete = true where id = uid;
end;
$$;

revoke all on function public.complete_support_setup(text) from public, anon;
grant execute on function public.complete_support_setup(text) to authenticated;
