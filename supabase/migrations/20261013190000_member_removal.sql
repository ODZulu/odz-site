-- MVA-209: member removal tool.
--
-- Soft removal (remove_member): the account is locked out, private data is purged, public
-- roster fields stay for the archive. Hard delete (delete_removed_member): erroneous accounts and
-- privacy requests, only for already-removed members. Both are Admin-only SECURITY DEFINER RPCs.
--
-- Additive: one new status value, three nullable/new objects, no existing row is rewritten.
-- Deviation from the ticket wording, on purpose: the free-text reason lives in the Admin-only
-- `member_removals` log, not on `profiles`, because every approved member (and the removed member
-- themselves) can read `profiles` rows they are allowed to see. `profiles` carries status,
-- removed_at and removed_by.

------------------------------------------------------------------------------
-- Status and columns
------------------------------------------------------------------------------

alter table public.profiles drop constraint profiles_status_check;
alter table public.profiles
  add constraint profiles_status_check check (status in ('pending', 'approved', 'suspended', 'removed'));

alter table public.profiles add column removed_at timestamptz;
alter table public.profiles add column removed_by uuid references public.profiles (id) on delete set null;

------------------------------------------------------------------------------
-- Admin-only removal log (who, whom, when, why). No FK on profile_id: the log outlives the profile.
------------------------------------------------------------------------------

create table public.member_removals (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  callsign text,                       -- snapshot, so a hard-deleted member is still identifiable to Admin
  action text not null check (action in ('removed', 'deleted')),
  actor_id uuid,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  created_at timestamptz not null default now()
);

create index member_removals_profile_idx on public.member_removals (profile_id, created_at);

revoke all on public.member_removals from anon, authenticated;
grant select on public.member_removals to authenticated;
alter table public.member_removals enable row level security;
-- No insert/update/delete policy: only the RPCs below write it.
create policy member_removals_select on public.member_removals
  for select to authenticated using (public.current_user_is_admin());

------------------------------------------------------------------------------
-- Guard: 'removed' is reachable only through remove_member(); a removed row is frozen
------------------------------------------------------------------------------
-- The rest of the guard is unchanged from 20261011140000.

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
-- A removed member's private data can never be written again (covers complete_setup for an
-- account removed before it finished setup, and any future writer)
------------------------------------------------------------------------------

create function public.member_private_no_removed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.profiles p where p.id = new.profile_id and p.status = 'removed') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.member_private_no_removed() from public, anon, authenticated;

create trigger member_private_no_removed
  before insert or update on public.member_private
  for each row execute function public.member_private_no_removed();

------------------------------------------------------------------------------
-- Authorship survives hard delete
------------------------------------------------------------------------------
-- The `created_by` foreign keys are ON DELETE SET NULL, but the BEFORE UPDATE triggers below pin
-- created_by to its old value, which turns that SET NULL into a foreign-key error. They now let
-- created_by go to null, and only when the author no longer exists. Nested ifs on purpose: the
-- lookup runs only in that case, never for an ordinary edit by a signed-in client. Everything else
-- in these functions is unchanged; updated_at is kept so the clean-up does not look like an edit.

create or replace function public.events_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.external_id := old.external_id;
    if new.created_by is null and old.created_by is not null then
      if not exists (select 1 from auth.users u where u.id = old.created_by) then
        new.updated_at := old.updated_at;   -- author clean-up, not an edit
      else
        new.created_by := old.created_by;
      end if;
    else
      new.created_by := old.created_by;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.minutes_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    if new.created_by is null and old.created_by is not null then
      if not exists (select 1 from auth.users u where u.id = old.created_by) then
        new.updated_at := old.updated_at;   -- author clean-up, not an edit
      else
        new.created_by := old.created_by;
      end if;
    else
      new.created_by := old.created_by;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.documents_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  new.version := btrim(new.version);
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    if new.created_by is null and old.created_by is not null then
      if not exists (select 1 from auth.users u where u.id = old.created_by) then
        new.updated_at := old.updated_at;   -- author clean-up, not an edit
      else
        new.created_by := old.created_by;
      end if;
    else
      new.created_by := old.created_by;
    end if;
  end if;
  -- Ratifying a version supersedes the one it replaces, so the unique index never trips.
  if new.status = 'ratified' then
    update public.documents d set status = 'superseded'
     where d.slug = new.slug and d.status = 'ratified' and d.id <> new.id;
  end if;
  return new;
end;
$$;

create or replace function public.traffic_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  new.body := btrim(new.body);
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    if new.created_by is null and old.created_by is not null then
      if not exists (select 1 from public.profiles u where u.id = old.created_by) then
        new.updated_at := old.updated_at;   -- author clean-up, not an edit
      else
        new.created_by := old.created_by;
      end if;
    else
      new.created_by := old.created_by;
    end if;
  end if;
  return new;
end;
$$;

------------------------------------------------------------------------------
-- remove_member(): soft removal
------------------------------------------------------------------------------

create function public.remove_member(p_profile uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  target public.profiles;
begin
  if not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;
  if p_profile = auth.uid() then
    raise exception 'cannot_remove_self' using errcode = 'P0001';
  end if;

  select * into target from public.profiles where id = p_profile for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if target.status = 'removed' then
    raise exception 'already_removed' using errcode = 'P0001';
  end if;
  if target.is_admin and target.status = 'approved' then
    perform 1 from public.profiles p
      where p.id <> target.id and p.is_admin and p.status = 'approved';
    if not found then
      raise exception 'last_admin' using errcode = 'P0001';
    end if;
  end if;

  -- Mark the profile. The tier is kept: seniority and history are not touched.
  perform set_config('odz.member_removal', 'on', true);
  update public.profiles
     set status = 'removed', removed_at = now(), removed_by = auth.uid(), is_admin = false
   where id = p_profile;
  perform set_config('odz.member_removal', 'off', true);

  insert into public.member_removals (profile_id, callsign, action, actor_id, reason)
  values (p_profile, target.callsign, 'removed', auth.uid(), v_reason);

  -- Private details are purged; roster fields stay for the archive.
  delete from public.member_private where profile_id = p_profile;

  -- No more notifications or pushes.
  delete from public.push_subscriptions where profile_id = p_profile;
  delete from public.notification_prefs where profile_id = p_profile;
  delete from public.notifications where profile_id = p_profile;

  -- Their unused invites stop working. (A code they redeemed is already single-use.)
  update public.invites set revoked_at = now()
   where created_by = p_profile and used_at is null and revoked_at is null;

  -- Lock the sign-in itself: banned, and every session ended. Row-level security already
  -- denies a removed profile everything; this stops new tokens as well.
  update auth.users set banned_until = now() + interval '100 years' where id = p_profile;
  delete from auth.sessions where user_id = p_profile;
end;
$$;

------------------------------------------------------------------------------
-- delete_removed_member(): hard delete, removed members only
------------------------------------------------------------------------------

create function public.delete_removed_member(p_profile uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  target public.profiles;
begin
  if not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;
  if p_profile = auth.uid() then
    raise exception 'cannot_remove_self' using errcode = 'P0001';
  end if;

  select * into target from public.profiles where id = p_profile for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if target.status <> 'removed' then
    raise exception 'not_removed' using errcode = 'P0001';
  end if;

  insert into public.member_removals (profile_id, callsign, action, actor_id, reason)
  values (p_profile, target.callsign, 'deleted', auth.uid(), v_reason);

  -- Deleting the auth user cascades to the profile and its dependants (private data, RSVPs,
  -- notifications). Events, minutes, documents and traffic they wrote keep their rows with the
  -- author set to null (shown as "Former member"); invites keep their rows with used_by/created_by null.
  delete from auth.users where id = p_profile;
end;
$$;

revoke all on function public.remove_member(uuid, text) from public, anon;
revoke all on function public.delete_removed_member(uuid, text) from public, anon;
grant execute on function public.remove_member(uuid, text) to authenticated;
grant execute on function public.delete_removed_member(uuid, text) to authenticated;

------------------------------------------------------------------------------
-- Audit feed: removals are shown to Admin only (reason included)
------------------------------------------------------------------------------
-- Same as 20261011160000 plus the member_removals branch.

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
                  else coalesce(a.old_value, '-') || ' -> ' || coalesce(a.new_value, '-') end as detail
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
