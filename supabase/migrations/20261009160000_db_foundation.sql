-- MVA-198: DB foundation. Tiers, capabilities, profiles, approval states, RLS.
-- Decisions: Playbook D7 (signup + approval), D9 (tier-based, data-driven), D10 (capability defaults).
--
-- Model:
--   * Tiers are rows. Lower `rank` = more authority (Command = 1). Admin is NOT a tier;
--     it is the `is_admin` flag on profiles.
--   * Permissions are capabilities attached to tiers. Policies call has_capability(); there
--     is no UI-only gating.
--   * New signups get a `pending` profile with no tier and therefore no capabilities.

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

create table public.tiers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0),
  rank integer not null,
  is_default_for_approval boolean not null default false
);

-- At most one tier is the default assigned on approval.
create unique index tiers_one_default_for_approval
  on public.tiers (is_default_for_approval) where is_default_for_approval;

create table public.capabilities (
  key text primary key,
  description text not null
);

create table public.tier_capabilities (
  tier_id uuid not null references public.tiers (id) on delete cascade,
  capability_key text not null references public.capabilities (key) on delete cascade on update cascade,
  primary key (tier_id, capability_key)
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  callsign text check (callsign is null or length(btrim(callsign)) > 0),
  display_name text,
  tier_id uuid references public.tiers (id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended')),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- Callsigns are unique regardless of case. Null (not yet chosen) is allowed many times.
create unique index profiles_callsign_key on public.profiles (lower(callsign));

------------------------------------------------------------------------------
-- Permission helpers (security definer so they can read profiles without recursing
-- through the profiles RLS policies that call them)
------------------------------------------------------------------------------

create function public.current_user_is_approved()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.status = 'approved'
  );
$$;

create function public.current_user_is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.status = 'approved' and p.is_admin
  );
$$;

-- True if the caller is approved and (is admin, or their tier holds the capability).
-- Pending and suspended users get false for everything.
create function public.has_capability(cap text)
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
      )
  );
$$;

revoke all on function public.current_user_is_approved() from public, anon;
revoke all on function public.current_user_is_admin() from public, anon;
revoke all on function public.has_capability(text) from public, anon;
grant execute on function public.current_user_is_approved() to authenticated;
grant execute on function public.current_user_is_admin() to authenticated;
grant execute on function public.has_capability(text) to authenticated;

------------------------------------------------------------------------------
-- Signup trigger: every new auth user gets a pending profile
------------------------------------------------------------------------------

create function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

------------------------------------------------------------------------------
-- Profile guard: privileged columns and the last-admin rule
------------------------------------------------------------------------------
-- Column privileges let signed-in users update status/tier_id/is_admin at the SQL level so
-- that approvers can work; this trigger decides who may actually change them.
-- Callers with no JWT (SQL editor, migrations, service role) are trusted for the privileged
-- column rules, but the last-admin rule applies to everyone.

create function public.profiles_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
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

  -- UPDATE
  if new.id <> old.id then
    raise exception 'profile id cannot be changed' using errcode = '42501';
  end if;

  if old.is_admin and old.status = 'approved' and (not new.is_admin or new.status <> 'approved') then
    perform 1 from public.profiles p
      where p.id <> old.id and p.is_admin and p.status = 'approved'
      for update;
    if not found then
      raise exception 'cannot demote or suspend the last admin' using errcode = 'P0001';
    end if;
  end if;

  if auth.uid() is not null then
    if new.is_admin is distinct from old.is_admin and not public.current_user_is_admin() then
      raise exception 'only admins can change is_admin' using errcode = '42501';
    end if;

    if new.status is distinct from old.status or new.tier_id is distinct from old.tier_id then
      if not public.has_capability('approve_members') then
        raise exception 'not allowed to change status or tier' using errcode = '42501';
      end if;
      if not public.current_user_is_admin() then
        if old.id = auth.uid() then
          raise exception 'cannot change your own status or tier' using errcode = '42501';
        end if;
        if old.is_admin then
          raise exception 'only admins can change an admin profile' using errcode = '42501';
        end if;
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.profiles_guard() from public, anon, authenticated;

create trigger profiles_guard
  before update or delete on public.profiles
  for each row execute function public.profiles_guard();

------------------------------------------------------------------------------
-- Grants (Supabase default privileges hand everything to anon/authenticated; take it back)
------------------------------------------------------------------------------

revoke all on public.tiers, public.capabilities, public.tier_capabilities, public.profiles
  from anon, authenticated;

grant select, insert, update, delete on public.tiers, public.capabilities, public.tier_capabilities
  to authenticated;

grant select on public.profiles to authenticated;
grant update (callsign, display_name, tier_id, status, is_admin) on public.profiles to authenticated;

------------------------------------------------------------------------------
-- RLS
------------------------------------------------------------------------------

alter table public.tiers enable row level security;
alter table public.capabilities enable row level security;
alter table public.tier_capabilities enable row level security;
alter table public.profiles enable row level security;

-- tiers, capabilities, tier_capabilities: approved users read, admins write.
create policy tiers_select on public.tiers
  for select to authenticated using (public.current_user_is_approved());
create policy tiers_insert on public.tiers
  for insert to authenticated with check (public.current_user_is_admin());
create policy tiers_update on public.tiers
  for update to authenticated using (public.current_user_is_admin()) with check (public.current_user_is_admin());
create policy tiers_delete on public.tiers
  for delete to authenticated using (public.current_user_is_admin());

create policy capabilities_select on public.capabilities
  for select to authenticated using (public.current_user_is_approved());
create policy capabilities_insert on public.capabilities
  for insert to authenticated with check (public.current_user_is_admin());
create policy capabilities_update on public.capabilities
  for update to authenticated using (public.current_user_is_admin()) with check (public.current_user_is_admin());
create policy capabilities_delete on public.capabilities
  for delete to authenticated using (public.current_user_is_admin());

create policy tier_capabilities_select on public.tier_capabilities
  for select to authenticated using (public.current_user_is_approved());
create policy tier_capabilities_insert on public.tier_capabilities
  for insert to authenticated with check (public.current_user_is_admin());
create policy tier_capabilities_update on public.tier_capabilities
  for update to authenticated using (public.current_user_is_admin()) with check (public.current_user_is_admin());
create policy tier_capabilities_delete on public.tier_capabilities
  for delete to authenticated using (public.current_user_is_admin());

-- profiles: no insert policy (the signup trigger creates rows) and no delete policy.
-- Everyone reads their own row (a pending user must see their own status).
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));

-- Approved users read the approved roster.
create policy profiles_select_roster on public.profiles
  for select to authenticated
  using (status = 'approved' and public.current_user_is_approved());

-- Approvers (and admins) also see pending and suspended rows to work the queue.
create policy profiles_select_approvers on public.profiles
  for select to authenticated using (public.has_capability('approve_members'));

-- Own row: callsign/display_name only in practice; the guard trigger blocks the rest.
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) and status in ('pending', 'approved'))
  with check (id = (select auth.uid()));

create policy profiles_update_approvers on public.profiles
  for update to authenticated
  using (public.has_capability('approve_members'))
  with check (public.has_capability('approve_members'));

------------------------------------------------------------------------------
-- Seed: configuration only, no member data
------------------------------------------------------------------------------

insert into public.tiers (name, rank, is_default_for_approval) values
  ('Command',   1, false),
  ('Old Guard', 2, false),
  ('Member',    3, true),
  ('Prospect',  4, false),
  ('Recruit',   5, false);

insert into public.capabilities (key, description) values
  ('approve_members',    'Approve, suspend and assign tiers to member accounts'),
  ('write_minutes',      'Create and edit meeting minutes'),
  ('write_events',       'Create and edit calendar events'),
  ('read_minutes',       'Read meeting minutes'),
  ('read_event_details', 'Read event location and details');

-- Every tier reads minutes and event details.
insert into public.tier_capabilities (tier_id, capability_key)
select t.id, c.key
from public.tiers t
cross join public.capabilities c
where c.key in ('read_minutes', 'read_event_details');

-- Command also approves members and writes minutes and events (Dax, 2026-10-09).
insert into public.tier_capabilities (tier_id, capability_key)
select t.id, c.key
from public.tiers t
cross join public.capabilities c
where t.name = 'Command'
  and c.key in ('approve_members', 'write_minutes', 'write_events');
