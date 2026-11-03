-- MVA-220: designations. Duty roles (Treasurer, Quartermaster, Shop Manager, XO, Training
-- Officer) are separate from the rank ladder and the Admin flag. A designation grants a
-- capability and shows on the profile, so people can be found and notified by duty.
--
--   * designations is the catalog: name, description, the capability it grants (one capability
--     per designation, so "does X hold the capability" and "is X a holder of this designation"
--     stay the same question), whether it is an office seat, and its holder cap. Adding one later
--     needs no schema change beyond a new seed row and capability (Dax/Lord, catalog is additive).
--   * Office seats (office_seat = true: Treasurer, Quartermaster, XO, Training Officer) are
--     eligible to Command and Old Guard only -- reusing tiers.seat_group (MVA-234), not a name
--     check. Shop Manager (office_seat = false) is open to any tier, Support included (MVA-237).
--     One person may hold more than one seat (Dax ruling): member_designations has no per-profile
--     cap, only the per-designation max_holders.
--   * member_designations is the live assignment table (RPC-written only; no client insert/update/
--     delete policy, same shape as member_removals). designation_audit logs every assign/revoke
--     (who, whom, designation, when); no FK on profile_id, so it outlives a removed or deleted
--     profile, same reasoning as member_removals.
--   * has_capability() and my_capabilities() are extended (not replaced in spirit) to union in:
--     (a) capabilities from a profile's own designation assignments, and (b) every designation
--     capability for Command (tiers.seat_group = 'command'), automatically, Dax ruling 2026-10-13.
--     Because both functions read live rows with no caching, a rank demotion or a revoke removes
--     the capability on the next check -- no stale sessions to worry about.
--   * assign_designation() / revoke_designation() need edit_roster (Command by default, Admin
--     passes every check) -- the same gate as other roster-editing actions, so there is no
--     separate self-assign path for anyone else. Eligibility and the holder cap are enforced in
--     the database, not only offered or hidden by the UI.
--   * designation_holders() is the cross-app helper ("list active holders of designation X");
--     it excludes soft-removed members by only looking at approved profiles.
--   * designations_overview() is the authoritative check behind the Vacant list, visible to
--     Admin, edit_roster holders, and any approved seat holder (Old Guard or Command) -- the same
--     three-way check as seat_counts() (MVA-234).
--   * list_audit() picks up a designation_audit branch, visible to the same audience as the rest
--     of the feed (approve_members or edit_roster), same as the settings/profile/invite branches.
--
-- Amendment (Lord, 2026-11-02, run order v1.1 Block 1): also seed XO and Training Officer. Both
-- are office seats, one holder each, with placeholder capabilities (hold_office_xo,
-- hold_office_training) registered in the catalog but granting no powers yet; they exist only so
-- the appointment is recorded, shows as a badge, and appears on the Vacant list. Command inherits
-- them automatically like every other designation capability.
--
-- Additive only: three new tables, five new capabilities, five seed designation rows, new
-- functions, and two redefined functions (newest definitions below; neither has been touched
-- since the migration named in its comment).

------------------------------------------------------------------------------
-- Catalog
------------------------------------------------------------------------------

create table public.designations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0),
  description text not null,
  capability_key text not null unique references public.capabilities (key) on delete restrict,
  office_seat boolean not null default false,
  max_holders integer not null default 1 check (max_holders >= 1)
);

revoke all on public.designations from anon, authenticated;
grant select on public.designations to authenticated;
alter table public.designations enable row level security;

create policy designations_select on public.designations
  for select to authenticated using (public.current_user_is_approved());
-- No insert/update/delete policy: the catalog is migration-managed.

------------------------------------------------------------------------------
-- Live assignments (RPC-written only)
------------------------------------------------------------------------------

create table public.member_designations (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  designation_id uuid not null references public.designations (id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid,
  primary key (profile_id, designation_id)
);

revoke all on public.member_designations from anon, authenticated;
grant select on public.member_designations to authenticated;
alter table public.member_designations enable row level security;

-- Badges are shown on the roster and profile to any approved account, same visibility as the
-- roster itself; nothing here is more sensitive than a tier name.
create policy member_designations_select on public.member_designations
  for select to authenticated using (public.current_user_is_approved());
-- No insert/update/delete policy: only assign_designation() / revoke_designation() write it.

------------------------------------------------------------------------------
-- Audit (who, whom, designation, when). No FK on profile_id: the log outlives the profile.
------------------------------------------------------------------------------

create table public.designation_audit (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  callsign text,                       -- snapshot, so a later removal does not blank the log
  designation_name text not null,      -- snapshot
  action text not null check (action in ('assigned', 'revoked')),
  actor_id uuid,
  created_at timestamptz not null default now()
);

create index designation_audit_profile_idx on public.designation_audit (profile_id, created_at);

revoke all on public.designation_audit from anon, authenticated;
grant select on public.designation_audit to authenticated;
alter table public.designation_audit enable row level security;

create policy designation_audit_select on public.designation_audit
  for select to authenticated
  using (public.has_capability('approve_members') or public.has_capability('edit_roster'));
-- No insert/update/delete policy: only the RPCs below write it.

------------------------------------------------------------------------------
-- Capability union: a profile's own designations, plus Command's automatic inheritance
------------------------------------------------------------------------------
-- Copied from 20261010181521_db_foundation.sql (newest definition; untouched since).

create or replace function public.has_capability(cap text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.status = 'approved'
      and (
        p.is_admin
        or exists (
          select 1 from public.tier_capabilities tc
          where tc.tier_id = p.tier_id and tc.capability_key = cap
        )
        or exists (
          select 1 from public.member_designations md
          join public.designations d on d.id = md.designation_id
          where md.profile_id = p.id and d.capability_key = cap
        )
        or exists (
          -- Command holds every designation capability automatically (Dax ruling, 2026-10-13),
          -- without needing the designation assigned.
          select 1 from public.tiers t
          join public.designations d on d.capability_key = cap
          where t.id = p.tier_id and t.seat_group = 'command'
        )
      )
  );
$$;

-- Copied from 20261011140000_admin_settings.sql (newest definition; untouched since), with the
-- same two unions added.
create or replace function public.my_capabilities()
returns setof text
language sql stable security definer set search_path = ''
as $$
  select c.key
  from public.capabilities c
  where public.current_user_is_admin()
     or exists (
       select 1
       from public.profiles p
       join public.tier_capabilities tc on tc.tier_id = p.tier_id
       where p.id = auth.uid() and p.status = 'approved' and tc.capability_key = c.key
     )
     or exists (
       select 1
       from public.profiles p
       join public.member_designations md on md.profile_id = p.id
       join public.designations d on d.id = md.designation_id
       where p.id = auth.uid() and p.status = 'approved' and d.capability_key = c.key
     )
     or exists (
       select 1
       from public.profiles p
       join public.tiers t on t.id = p.tier_id
       join public.designations d on d.capability_key = c.key
       where p.id = auth.uid() and p.status = 'approved' and t.seat_group = 'command'
     )
  order by c.key;
$$;

------------------------------------------------------------------------------
-- Assign / revoke (edit_roster; Command by default, Admin passes every check)
------------------------------------------------------------------------------

create function public.assign_designation(p_profile uuid, p_designation uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  prof public.profiles;
  des public.designations;
  target_seat_group text;
  holders integer;
begin
  if not public.has_capability('edit_roster') then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select * into prof from public.profiles where id = p_profile for update;
  if not found or prof.status <> 'approved' then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select * into des from public.designations where id = p_designation;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.member_designations where profile_id = p_profile and designation_id = p_designation) then
    raise exception 'already_assigned' using errcode = 'P0001';
  end if;

  select t.seat_group into target_seat_group from public.tiers t where t.id = prof.tier_id;
  if des.office_seat and target_seat_group is null then
    raise exception 'not_eligible_tier' using errcode = 'P0001';
  end if;

  -- Advisory lock per designation, so two simultaneous assignments cannot both pass the cap.
  perform pg_advisory_xact_lock(hashtext('odz.designation.' || p_designation::text));
  select count(*) into holders from public.member_designations where designation_id = p_designation;
  if holders >= des.max_holders then
    raise exception 'designation_full' using errcode = 'P0001';
  end if;

  insert into public.member_designations (profile_id, designation_id, assigned_by)
  values (p_profile, p_designation, auth.uid());

  insert into public.designation_audit (profile_id, callsign, designation_name, action, actor_id)
  values (p_profile, prof.callsign, des.name, 'assigned', auth.uid());
end;
$$;

revoke all on function public.assign_designation(uuid, uuid) from public, anon;
grant execute on function public.assign_designation(uuid, uuid) to authenticated;

create function public.revoke_designation(p_profile uuid, p_designation uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  prof public.profiles;
  des public.designations;
begin
  if not public.has_capability('edit_roster') then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select * into des from public.designations where id = p_designation;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  delete from public.member_designations where profile_id = p_profile and designation_id = p_designation;
  if not found then
    raise exception 'not_assigned' using errcode = 'P0001';
  end if;

  select * into prof from public.profiles where id = p_profile;
  insert into public.designation_audit (profile_id, callsign, designation_name, action, actor_id)
  values (p_profile, prof.callsign, des.name, 'revoked', auth.uid());
end;
$$;

revoke all on function public.revoke_designation(uuid, uuid) from public, anon;
grant execute on function public.revoke_designation(uuid, uuid) to authenticated;

------------------------------------------------------------------------------
-- Cross-app helper: active holders of a designation (excludes soft-removed members)
------------------------------------------------------------------------------

create function public.designation_holders(p_designation uuid)
returns table (profile_id uuid, callsign text, display_name text)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.callsign, p.display_name
  from public.member_designations md
  join public.profiles p on p.id = md.profile_id
  where md.designation_id = p_designation and p.status = 'approved';
$$;

revoke all on function public.designation_holders(uuid) from public, anon;
grant execute on function public.designation_holders(uuid) to authenticated;

------------------------------------------------------------------------------
-- Overview for the Vacant list: Admin, edit_roster holders, or any seat holder
------------------------------------------------------------------------------
-- Same three-way check as seat_counts() (MVA-234): Old Guard and Command see it even with no
-- capability of their own.

create function public.designations_overview()
returns table (
  id uuid, name text, description text, capability_key text,
  office_seat boolean, max_holders integer, holder_count integer
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (
    public.current_user_is_admin()
    or public.has_capability('edit_roster')
    or exists (
      select 1 from public.profiles p join public.tiers t on t.id = p.tier_id
      where p.id = auth.uid() and p.status = 'approved' and t.seat_group is not null
    )
  ) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select d.id, d.name, d.description, d.capability_key, d.office_seat, d.max_holders,
           (select count(*)::integer from public.member_designations md
              join public.profiles p on p.id = md.profile_id
            where md.designation_id = d.id and p.status = 'approved')
    from public.designations d
    order by d.name;
end;
$$;

revoke all on function public.designations_overview() from public, anon;
grant execute on function public.designations_overview() to authenticated;

------------------------------------------------------------------------------
-- Audit feed: designation_audit branch
------------------------------------------------------------------------------
-- Copied from 20261013220000_support_tier.sql (newest definition; untouched since), plus the
-- designation_audit branch, visible to the same audience as the rest of the feed.

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
      union all
      select d.created_at,
             (select p.callsign from public.profiles p where p.id = d.actor_id),
             'designation'::text,
             d.action,
             coalesce(d.callsign, '(removed)'),
             d.designation_name
      from public.designation_audit d
    )
    select f.at, coalesce(f.actor, 'system'), f.kind, f.event, coalesce(f.target, '-'), f.detail,
           count(*) over ()
    from feed f
    order by f.at desc
    limit p_limit offset p_offset;
end;
$$;

------------------------------------------------------------------------------
-- Seed: five capabilities and five designations. Treasurer, Quartermaster, XO and Training
-- Officer are office seats (Command/Old Guard only, one holder each); Shop Manager is open to any
-- tier (Support included), also one holder. XO and Training Officer grant a placeholder
-- capability that exists only to record the appointment (Lord's amendment, run order v1.1).
------------------------------------------------------------------------------

insert into public.capabilities (key, description) values
  ('manage_treasury',    'Manage the team treasury ledger (Treasurer)'),
  ('manage_inventory',   'Manage team gear inventory and issue/return (Quartermaster)'),
  ('manage_shop',        'Manage the Sweat Shop catalog and orders (Shop Manager)'),
  ('hold_office_xo',      'Holds the XO office seat (placeholder, grants no powers yet)'),
  ('hold_office_training','Holds the Training Officer office seat (placeholder, grants no powers yet)');

insert into public.designations (name, description, capability_key, office_seat, max_holders) values
  ('Treasurer',        'Manages the team treasury ledger.',                   'manage_treasury',     true,  1),
  ('Quartermaster',     'Manages team gear inventory and issue/return.',       'manage_inventory',    true,  1),
  ('Shop Manager',      'Manages the Sweat Shop catalog and orders.',         'manage_shop',          false, 1),
  ('XO',                'Executive Officer (placeholder, grants no powers yet).', 'hold_office_xo',       true,  1),
  ('Training Officer',  'Training Officer (placeholder, grants no powers yet).', 'hold_office_training', true,  1);
