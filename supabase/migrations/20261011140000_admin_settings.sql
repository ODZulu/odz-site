-- MVA-141: admin settings. Invite codes shown once, tier and capability management with
-- server-side guards, a unified audit feed, and my_capabilities() for the UI.
--
-- Principles (same as before): the UI only hides things; the rules live here.
--   * An invite's full code is returned once, by create_invite(). After that only the last 4
--     characters (code_hint) are readable by anyone, including Command and Admin.
--   * Tiers and tier_capabilities change only through admin RPCs. Direct writes are revoked.
--   * Guards: Command's entry/release rules cannot be changed through the app; a tier with members
--     cannot be deleted; approve_members cannot be removed from every tier; view_member_private
--     needs a typed confirmation; nobody changes their own tier.

------------------------------------------------------------------------------
-- Tiers: which ones invites may grant is data, not a name check
------------------------------------------------------------------------------

alter table public.tiers add column invitable boolean not null default false;
update public.tiers set invitable = true where name in ('Recruit', 'Prospect', 'Contractor');

alter table public.tiers add constraint tiers_name_length check (length(name) <= 30);

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
    -- The least senior tier that invites may grant (Recruit in the seed).
    select id into new.tier_id from public.tiers where invitable order by rank desc limit 1;
  end if;
  select invitable into ok from public.tiers where id = new.tier_id;
  if ok is not true then
    raise exception 'invites cannot grant that tier' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

------------------------------------------------------------------------------
-- Invites: the code is write-once-read-once
------------------------------------------------------------------------------

alter table public.invites add column code_hint text;
update public.invites set code_hint = right(code, 4);

-- No role that talks to the API can read `code` again, and nobody inserts directly.
revoke select on public.invites from authenticated;
grant select (id, tier_id, created_by, created_at, expires_at, used_by, used_at, revoked_at, note, code_hint)
  on public.invites to authenticated;
revoke insert (tier_id, note) on public.invites from authenticated;
revoke insert on public.invites from authenticated;

create function public.create_invite(p_tier uuid default null, p_note text default null, p_days integer default 7)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_code text;
begin
  if not public.has_capability('approve_members') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 30 then
    raise exception 'invalid_days' using errcode = 'P0001';
  end if;
  insert into public.invites (tier_id, note, expires_at)
  values (p_tier, nullif(btrim(coalesce(p_note, '')), ''), now() + (p_days * interval '1 day'))
  returning code into v_code;
  return v_code;
end;
$$;

create function public.list_invites()
returns table (
  id uuid,
  code_hint text,
  tier text,
  note text,
  created_by text,
  created_at timestamptz,
  expires_at timestamptz,
  status text,
  used_by text
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.has_capability('approve_members') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select i.id, i.code_hint, t.name, i.note, cb.callsign, i.created_at, i.expires_at,
           case
             when i.used_at is not null then 'used'
             when i.revoked_at is not null then 'revoked'
             when i.expires_at <= now() then 'expired'
             else 'active'
           end,
           ub.callsign
    from public.invites i
    join public.tiers t on t.id = i.tier_id
    left join public.profiles cb on cb.id = i.created_by
    left join public.profiles ub on ub.id = i.used_by
    order by i.created_at desc;
end;
$$;

------------------------------------------------------------------------------
-- Settings audit (tier and capability changes)
------------------------------------------------------------------------------

create table public.settings_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  event text not null,
  target text not null,
  detail text,
  created_at timestamptz not null default now()
);

create function public.tiers_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'tier_created', new.name, 'rank ' || new.rank);
  elsif tg_op = 'DELETE' then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'tier_deleted', old.name, null);
  else
    if new.name is distinct from old.name then
      insert into public.settings_audit (actor_id, event, target, detail)
      values (auth.uid(), 'tier_renamed', new.name, old.name || ' -> ' || new.name);
    end if;
    if new.rank is distinct from old.rank then
      insert into public.settings_audit (actor_id, event, target, detail)
      values (auth.uid(), 'tier_reordered', new.name, 'rank ' || old.rank || ' -> ' || new.rank);
    end if;
  end if;
  return null;
end;
$$;

create trigger tiers_audit
  after insert or update or delete on public.tiers
  for each row execute function public.tiers_audit();

create function public.tier_capabilities_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  r public.tier_capabilities := case when tg_op = 'DELETE' then old else new end;
  tier_name text;
begin
  select name into tier_name from public.tiers where id = r.tier_id;
  if tier_name is null then
    return null;  -- the tier itself is being deleted; tier_deleted is logged
  end if;
  insert into public.settings_audit (actor_id, event, target, detail)
  values (auth.uid(), case when tg_op = 'DELETE' then 'capability_revoked' else 'capability_granted' end,
          tier_name, r.capability_key);
  return null;
end;
$$;

create trigger tier_capabilities_audit
  after insert or delete on public.tier_capabilities
  for each row execute function public.tier_capabilities_audit();

------------------------------------------------------------------------------
-- Guards
------------------------------------------------------------------------------

-- Command's entry/release rules are not editable through the app.
create function public.tiers_guard()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if auth.uid() is not null and (
       new.entry_requires_tier_id is distinct from old.entry_requires_tier_id
    or new.release_to_tier_id is distinct from old.release_to_tier_id
  ) then
    raise exception 'tier entry and release rules cannot be changed here' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger tiers_guard
  before update on public.tiers
  for each row execute function public.tiers_guard();

-- A tier that has members cannot be deleted.
create function public.tiers_delete_guard()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if exists (select 1 from public.profiles p where p.tier_id = old.id) then
    raise exception 'tier_has_members' using errcode = 'P0001';
  end if;
  return old;
end;
$$;

create trigger tiers_delete_guard
  before delete on public.tiers
  for each row execute function public.tiers_delete_guard();

-- approve_members can never be removed from every tier (lockout guard).
create function public.tier_capabilities_lockout_guard()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.capability_key = 'approve_members' and not exists (
    select 1 from public.tier_capabilities tc
    where tc.capability_key = 'approve_members' and tc.tier_id <> old.tier_id
  ) then
    raise exception 'approve_members_lockout' using errcode = 'P0001';
  end if;
  return old;
end;
$$;

create trigger tier_capabilities_lockout_guard
  before delete on public.tier_capabilities
  for each row execute function public.tier_capabilities_lockout_guard();

revoke all on function public.tiers_audit() from public, anon, authenticated;
revoke all on function public.tier_capabilities_audit() from public, anon, authenticated;
revoke all on function public.tiers_guard() from public, anon, authenticated;
revoke all on function public.tiers_delete_guard() from public, anon, authenticated;
revoke all on function public.tier_capabilities_lockout_guard() from public, anon, authenticated;

-- Nobody changes their own tier (admins included). The rest of the guard is unchanged from
-- 20261010181757; only the self-tier rule is new.
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
-- Admin RPCs for tiers and capabilities
------------------------------------------------------------------------------

create function public.create_tier(p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_name) = 0 or length(v_name) > 30 then
    raise exception 'invalid_name' using errcode = 'P0001';
  end if;
  insert into public.tiers (name, rank)
  values (v_name, coalesce((select max(rank) from public.tiers), 0) + 1)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'name_taken' using errcode = 'P0001';
end;
$$;

create function public.rename_tier(p_id uuid, p_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_name) = 0 or length(v_name) > 30 then
    raise exception 'invalid_name' using errcode = 'P0001';
  end if;
  update public.tiers set name = v_name where id = p_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
exception when unique_violation then
  raise exception 'name_taken' using errcode = 'P0001';
end;
$$;

-- p_ids lists every tier, most senior first. Ranks become 1..n in that order.
create function public.reorder_tiers(p_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
begin
  if not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select count(*) into n from public.tiers;
  if p_ids is null or cardinality(p_ids) <> n
     or (select count(distinct x) from unnest(p_ids) x) <> n
     or exists (select 1 from unnest(p_ids) x where not exists (select 1 from public.tiers t where t.id = x)) then
    raise exception 'invalid_order' using errcode = 'P0001';
  end if;
  update public.tiers t set rank = o.ord
  from unnest(p_ids) with ordinality as o(id, ord)
  where t.id = o.id and t.rank <> o.ord;
end;
$$;

create function public.delete_tier(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from public.tiers t where t.id = p_id and (t.entry_requires_tier_id is not null or t.release_to_tier_id is not null))
     or exists (select 1 from public.tiers t where t.entry_requires_tier_id = p_id or t.release_to_tier_id = p_id)
     or exists (select 1 from public.invites i where i.tier_id = p_id) then
    raise exception 'tier_in_rules' using errcode = 'P0001';
  end if;
  delete from public.tiers where id = p_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
end;
$$;

create function public.set_tier_capability(p_tier uuid, p_cap text, p_enabled boolean, p_confirm text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_cap = 'view_member_private' and p_confirm is distinct from 'PRIVATE' then
    raise exception 'confirmation_required' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.tiers where id = p_tier)
     or not exists (select 1 from public.capabilities where key = p_cap) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_enabled then
    insert into public.tier_capabilities (tier_id, capability_key) values (p_tier, p_cap)
    on conflict do nothing;
  else
    delete from public.tier_capabilities where tier_id = p_tier and capability_key = p_cap;
  end if;
end;
$$;

-- Direct writes are closed: everything goes through the RPCs above.
revoke insert, update, delete on public.tiers from authenticated;
revoke insert, update, delete on public.tier_capabilities from authenticated;
revoke insert, update, delete on public.capabilities from authenticated;

------------------------------------------------------------------------------
-- What the UI needs
------------------------------------------------------------------------------

create function public.my_capabilities()
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
  order by c.key;
$$;

-- One feed over every audit table: profiles, invites, settings. Private values never appear:
-- the profile 'private' event only carries field names.
create function public.list_audit(p_limit integer default 25, p_offset integer default 0)
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
             case when a.event = 'private' then 'fields: ' || coalesce(a.new_value, '')
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
    )
    select f.at, coalesce(f.actor, 'system'), f.kind, f.event, coalesce(f.target, '-'), f.detail,
           count(*) over ()
    from feed f
    order by f.at desc
    limit p_limit offset p_offset;
end;
$$;

revoke all on function public.create_invite(uuid, text, integer) from public, anon;
revoke all on function public.list_invites() from public, anon;
revoke all on function public.create_tier(text) from public, anon;
revoke all on function public.rename_tier(uuid, text) from public, anon;
revoke all on function public.reorder_tiers(uuid[]) from public, anon;
revoke all on function public.delete_tier(uuid) from public, anon;
revoke all on function public.set_tier_capability(uuid, text, boolean, text) from public, anon;
revoke all on function public.my_capabilities() from public, anon;
revoke all on function public.list_audit(integer, integer) from public, anon;
grant execute on function public.create_invite(uuid, text, integer) to authenticated;
grant execute on function public.list_invites() to authenticated;
grant execute on function public.create_tier(text) to authenticated;
grant execute on function public.rename_tier(uuid, text) to authenticated;
grant execute on function public.reorder_tiers(uuid[]) to authenticated;
grant execute on function public.delete_tier(uuid) to authenticated;
grant execute on function public.set_tier_capability(uuid, text, boolean, text) to authenticated;
grant execute on function public.my_capabilities() to authenticated;
grant execute on function public.list_audit(integer, integer) to authenticated;

-- settings_audit: readable by approvers and roster editors, written only by triggers.
revoke all on public.settings_audit from anon, authenticated;
grant select on public.settings_audit to authenticated;
alter table public.settings_audit enable row level security;
create policy settings_audit_select on public.settings_audit
  for select to authenticated
  using (public.has_capability('approve_members') or public.has_capability('edit_roster'));
