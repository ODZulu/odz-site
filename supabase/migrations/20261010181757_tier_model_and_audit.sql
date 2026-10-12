-- MVA-198 follow-up: Dax decisions 2026-10-09 and 2026-10-10 (Linear comments on MVA-198).
--   * Contractor is back. Ladder: Command > Old Guard > Member > Contractor > Prospect > Recruit.
--     Admin stays a flag (D9), not a tier.
--   * Command requires Old Guard to enter; leaving Command returns the member to Old Guard.
--     Modelled as data on the tier (entry_requires_tier_id, release_to_tier_id), so renaming
--     tiers never breaks the rule. One tier per user; no base_standing field.
--   * New capability `edit_roster` (edit the roster and change a member's tier). Default: Command.
--   * Audit: who changed a status or tier (and when), in an append-only table.
--   * Default tier for approval is now Recruit (invite codes carry the requested tier, default
--     Recruit; MVA-199).
-- Written as a new file so it applies cleanly whether or not the first migration is already applied.

------------------------------------------------------------------------------
-- Tier rules as data
------------------------------------------------------------------------------

alter table public.tiers
  add column entry_requires_tier_id uuid references public.tiers (id),
  add column release_to_tier_id uuid references public.tiers (id),
  add constraint tiers_rules_not_self check (
    entry_requires_tier_id is distinct from id and release_to_tier_id is distinct from id
  );

------------------------------------------------------------------------------
-- Seed changes
------------------------------------------------------------------------------

update public.tiers set rank = rank + 1 where name in ('Prospect', 'Recruit');

insert into public.tiers (name, rank, is_default_for_approval) values ('Contractor', 4, false);

-- Contractor reads minutes and event details like every other tier.
insert into public.tier_capabilities (tier_id, capability_key)
select t.id, c.key
from public.tiers t
cross join public.capabilities c
where t.name = 'Contractor' and c.key in ('read_minutes', 'read_event_details');

-- Default tier on approval: Recruit (clear the old default first; only one allowed).
update public.tiers set is_default_for_approval = false where is_default_for_approval;
update public.tiers set is_default_for_approval = true where name = 'Recruit';

insert into public.capabilities (key, description) values
  ('edit_roster', 'Edit the roster and change a member''s tier');

insert into public.tier_capabilities (tier_id, capability_key)
select t.id, 'edit_roster' from public.tiers t where t.name = 'Command';

-- Command: entry requires Old Guard, leaving returns to Old Guard.
update public.tiers c
   set entry_requires_tier_id = og.id, release_to_tier_id = og.id
  from public.tiers og
 where c.name = 'Command' and og.name = 'Old Guard';

------------------------------------------------------------------------------
-- Audit log (append-only; written only by the trigger below)
------------------------------------------------------------------------------

create table public.profile_audit (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,          -- no FK on purpose: the log outlives the profile
  actor_id uuid,                     -- null when changed from the SQL editor or service role
  event text not null check (event in ('status', 'tier', 'admin')),
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);

create index profile_audit_profile_idx on public.profile_audit (profile_id, created_at);

revoke all on public.profile_audit from anon, authenticated;
grant select on public.profile_audit to authenticated;

alter table public.profile_audit enable row level security;

-- Approvers and roster editors (and admins, who pass has_capability) read the log.
-- No insert/update/delete policy: clients cannot write it.
create policy profile_audit_select on public.profile_audit
  for select to authenticated
  using (public.has_capability('approve_members') or public.has_capability('edit_roster'));

create function public.profiles_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value)
    values (new.id, auth.uid(), 'status', old.status, new.status);
  end if;

  if new.tier_id is distinct from old.tier_id then
    insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value)
    values (
      new.id, auth.uid(), 'tier',
      (select t.name from public.tiers t where t.id = old.tier_id),
      (select t.name from public.tiers t where t.id = new.tier_id)
    );
  end if;

  if new.is_admin is distinct from old.is_admin then
    insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value)
    values (new.id, auth.uid(), 'admin', old.is_admin::text, new.is_admin::text);
  end if;

  return null;
end;
$$;

revoke all on function public.profiles_audit() from public, anon, authenticated;

create trigger profiles_audit
  after update on public.profiles
  for each row execute function public.profiles_audit();

------------------------------------------------------------------------------
-- Guard: tier rules, split capabilities
------------------------------------------------------------------------------
-- status changes need approve_members.
-- tier changes need edit_roster, except approving a pending account (pending -> approved) may
-- assign the tier with approve_members alone.
-- Tier entry/release rules apply to every caller, including the SQL editor.

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

  -- Tier rules (data-driven): release first, then entry.
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
-- Policies: roster editors may update other profiles (the guard trigger decides what)
------------------------------------------------------------------------------

drop policy profiles_update_approvers on public.profiles;

create policy profiles_update_managers on public.profiles
  for update to authenticated
  using (public.has_capability('approve_members') or public.has_capability('edit_roster'))
  with check (public.has_capability('approve_members') or public.has_capability('edit_roster'));
