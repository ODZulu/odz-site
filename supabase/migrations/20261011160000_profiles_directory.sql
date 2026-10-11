-- MVA-204: member directory and own profile.
--   * profiles gain role_note (<=60), bio (<=280) and joined_at (set the first time a profile is
--     approved).
--   * Members edit only their own display_name, role_note and bio, through update_own_profile().
--     Direct updates of profiles are closed to everyone except roster managers, and only for tier,
--     status and is_admin (the guard trigger still decides who may do what).
--   * Callsign changes are Command-only through set_callsign() (edit_roster), unique and audited.
--   * update_own_private() lets a member correct their own private details, validated like setup
--     and never echoing values in errors.
--   * All profile changes are audited by FIELD NAME only.

------------------------------------------------------------------------------
-- Columns
------------------------------------------------------------------------------

alter table public.profiles
  add column role_note text,
  add column bio text,
  add column joined_at timestamptz,
  add constraint profiles_role_note_length check (role_note is null or length(role_note) <= 60),
  add constraint profiles_bio_length check (bio is null or length(bio) <= 280);

-- Backfill: the first 'approved' status event, else the signup date.
update public.profiles p
   set joined_at = coalesce(
     (select min(a.created_at) from public.profile_audit a
       where a.profile_id = p.id and a.event = 'status' and a.new_value = 'approved'),
     p.created_at)
 where p.status = 'approved' and p.joined_at is null;

create function public.profiles_joined()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.status = 'approved' and new.joined_at is null
     and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    new.joined_at := now();
  end if;
  return new;
end;
$$;

create trigger profiles_joined
  before insert or update on public.profiles
  for each row execute function public.profiles_joined();

revoke all on function public.profiles_joined() from public, anon, authenticated;

------------------------------------------------------------------------------
-- Audit: field names for profile edits
------------------------------------------------------------------------------

alter table public.profile_audit drop constraint profile_audit_event_check;
alter table public.profile_audit
  add constraint profile_audit_event_check check (event in ('status', 'tier', 'admin', 'private', 'profile'));

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

-- The unified feed shows field names for 'profile' and 'private' events.
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
    )
    select f.at, coalesce(f.actor, 'system'), f.kind, f.event, coalesce(f.target, '-'), f.detail,
           count(*) over ()
    from feed f
    order by f.at desc
    limit p_limit offset p_offset;
end;
$$;

------------------------------------------------------------------------------
-- Direct updates: managers only, and only for tier, status and is_admin
------------------------------------------------------------------------------

revoke update on public.profiles from authenticated;
grant update (tier_id, status, is_admin) on public.profiles to authenticated;
drop policy profiles_update_own on public.profiles;

------------------------------------------------------------------------------
-- RPCs
------------------------------------------------------------------------------

create function public.update_own_profile(p_display_name text, p_role_note text, p_bio text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  v_name text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_role text := nullif(btrim(coalesce(p_role_note, '')), '');
  v_bio text := nullif(btrim(coalesce(p_bio, '')), '');
begin
  if uid is null or not exists (select 1 from public.profiles p where p.id = uid and p.status = 'approved') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_name is not null and length(v_name) > 60 then
    raise exception 'invalid_display_name' using errcode = 'P0001';
  end if;
  if v_role is not null and length(v_role) > 60 then
    raise exception 'invalid_role_note' using errcode = 'P0001';
  end if;
  if v_bio is not null and length(v_bio) > 280 then
    raise exception 'invalid_bio' using errcode = 'P0001';
  end if;
  update public.profiles set display_name = v_name, role_note = v_role, bio = v_bio where id = uid;
end;
$$;

-- Command changes a callsign. Same format as setup, unique ignoring case.
create function public.set_callsign(p_profile uuid, p_callsign text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_callsign text := btrim(coalesce(p_callsign, ''));
  target public.profiles;
begin
  if not public.has_capability('edit_roster') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_callsign !~ '^[A-Za-z0-9 _-]{2,24}$' then
    raise exception 'invalid_callsign' using errcode = 'P0001';
  end if;
  select * into target from public.profiles where id = p_profile;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if target.is_admin and not public.current_user_is_admin() then
    raise exception 'only admins can change an admin profile' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles p where lower(p.callsign) = lower(v_callsign) and p.id <> p_profile) then
    raise exception 'callsign_taken' using errcode = 'P0001';
  end if;
  update public.profiles set callsign = v_callsign where id = p_profile;
end;
$$;

-- Shared checks for private details. Errors are fixed codes and never contain the value.
create function public.assert_private_valid(
  p_legal_name text, p_dob date, p_phone text, p_allergies text,
  p_emergency_name text, p_emergency_relationship text, p_emergency_phone text
)
returns void
language plpgsql immutable set search_path = ''
as $$
declare
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_ephone text := btrim(coalesce(p_emergency_phone, ''));
begin
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
end;
$$;

create function public.update_own_private(
  p_legal_name text, p_dob date, p_phone text, p_allergies text,
  p_emergency_name text, p_emergency_relationship text, p_emergency_phone text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null or not exists (select 1 from public.profiles p where p.id = uid and p.status <> 'suspended' and p.setup_complete) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.assert_private_valid(p_legal_name, p_dob, p_phone, p_allergies,
                                      p_emergency_name, p_emergency_relationship, p_emergency_phone);
  update public.member_private set
    legal_name = btrim(p_legal_name),
    dob = p_dob,
    phone = nullif(btrim(coalesce(p_phone, '')), ''),
    allergies = btrim(p_allergies),
    emergency_name = btrim(p_emergency_name),
    emergency_relationship = btrim(p_emergency_relationship),
    emergency_phone = btrim(p_emergency_phone)
  where profile_id = uid;
  if not found then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_private_valid(text, date, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.update_own_profile(text, text, text) from public, anon;
revoke all on function public.set_callsign(uuid, text) from public, anon;
revoke all on function public.update_own_private(text, date, text, text, text, text, text) from public, anon;
grant execute on function public.update_own_profile(text, text, text) to authenticated;
grant execute on function public.set_callsign(uuid, text) to authenticated;
grant execute on function public.update_own_private(text, date, text, text, text, text, text) to authenticated;
