-- MVA-210: member service history and prior missions (archive + seniority display).
-- The team has ops dating back to 2014/2015 that predate the app; seniority drives Old Guard
-- promotion ("next most senior"), so members need an editable service record: date of
-- enlistment (DOE) and a list of past missions/events, including ones never run through the app.
--
--   * DOE lives in its own table (service_records), not on profiles, for the same reason
--     member_private is its own table: RLS is per-row, not per-column, and DOE is restricted to a
--     narrower audience than the roster-wide profile fields. service_history holds the entries
--     (date, title, location, role, notes, source = 'app' or 'manual').
--   * can_view_service_record(profile) is the shared read gate: the owner, Admin, edit_roster
--     holders, or any seat holder (Old Guard or Command) -- the same three-way check as
--     seat_counts() and designations_overview(), plus the owner. Writes need edit_roster.
--   * Seniority is a display metric only (Dax ruling, 2026-10-13): no computed rank, no
--     tie-break logic. The app shows DOE, years of service and mission count; a human on Old
--     Guard/Command compares them. Missing DOE is flagged in the UI, not computed around.
--   * History entries have no FK-driven deletion on soft removal (removal never deletes the
--     profile row), so they survive it unchanged. A hard delete cascades them away with the rest
--     of the profile, consistent with member_removals' "no orphaned rows" rule.
--   * Mission count is simply count(*) on service_history: manual/archive entries and any future
--     app-recorded attendance (source = 'app') both land in the same table, so the count already
--     includes both without extra plumbing.
--
-- Additive only: two new tables, new functions. No existing row is touched.

------------------------------------------------------------------------------
-- DOE (one row per profile, so RLS can gate it separately from the roster-wide profile fields)
------------------------------------------------------------------------------

create table public.service_records (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  doe date,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

------------------------------------------------------------------------------
-- History entries
------------------------------------------------------------------------------

create table public.service_history (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  event_date date not null,
  title text not null check (length(btrim(title)) between 1 and 80),
  location text check (location is null or length(location) <= 80),
  role text check (role is null or length(role) <= 60),
  notes text check (notes is null or length(notes) <= 500),
  source text not null default 'manual' check (source in ('app', 'manual')),
  created_by uuid,
  created_at timestamptz not null default now()
);

create index service_history_profile_idx on public.service_history (profile_id, event_date);

------------------------------------------------------------------------------
-- Shared read gate
------------------------------------------------------------------------------

create function public.can_view_service_record(p_profile uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_profile = auth.uid()
     or public.current_user_is_admin()
     or public.has_capability('edit_roster')
     or exists (
       select 1 from public.profiles p join public.tiers t on t.id = p.tier_id
       where p.id = auth.uid() and p.status = 'approved' and t.seat_group is not null
     );
$$;

revoke all on function public.can_view_service_record(uuid) from public, anon;
grant execute on function public.can_view_service_record(uuid) to authenticated;

------------------------------------------------------------------------------
-- RLS
------------------------------------------------------------------------------

revoke all on public.service_records from anon, authenticated;
grant select on public.service_records to authenticated;
alter table public.service_records enable row level security;
create policy service_records_select on public.service_records
  for select to authenticated using (public.can_view_service_record(profile_id));
-- No insert/update/delete policy: only set_doe() writes it.

revoke all on public.service_history from anon, authenticated;
grant select on public.service_history to authenticated;
alter table public.service_history enable row level security;
create policy service_history_select on public.service_history
  for select to authenticated using (public.can_view_service_record(profile_id));
-- No insert/update/delete policy: only the RPCs below write it.

------------------------------------------------------------------------------
-- Writes: edit_roster only (Command by default, Admin passes every check)
------------------------------------------------------------------------------

create function public.set_doe(p_profile uuid, p_doe date)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_capability('edit_roster') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  insert into public.service_records (profile_id, doe, updated_by)
  values (p_profile, p_doe, auth.uid())
  on conflict (profile_id) do update set doe = excluded.doe, updated_at = now(), updated_by = excluded.updated_by;
end;
$$;

revoke all on function public.set_doe(uuid, date) from public, anon;
grant execute on function public.set_doe(uuid, date) to authenticated;

create function public.add_service_entry(
  p_profile uuid, p_event_date date, p_title text, p_location text, p_role text, p_notes text, p_source text default 'manual'
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  new_id uuid;
  v_title text := btrim(coalesce(p_title, ''));
begin
  if not public.has_capability('edit_roster') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_event_date is null then
    raise exception 'invalid_date' using errcode = 'P0001';
  end if;
  if length(v_title) < 1 or length(v_title) > 80 then
    raise exception 'invalid_title' using errcode = 'P0001';
  end if;
  if coalesce(p_source, 'manual') not in ('app', 'manual') then
    raise exception 'invalid_source' using errcode = 'P0001';
  end if;

  insert into public.service_history (profile_id, event_date, title, location, role, notes, source, created_by)
  values (p_profile, p_event_date, v_title, nullif(btrim(coalesce(p_location, '')), ''), nullif(btrim(coalesce(p_role, '')), ''),
          nullif(btrim(coalesce(p_notes, '')), ''), coalesce(p_source, 'manual'), auth.uid())
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.add_service_entry(uuid, date, text, text, text, text, text) from public, anon;
grant execute on function public.add_service_entry(uuid, date, text, text, text, text, text) to authenticated;

create function public.update_service_entry(
  p_id uuid, p_event_date date, p_title text, p_location text, p_role text, p_notes text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
begin
  if not public.has_capability('edit_roster') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.service_history where id = p_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_event_date is null then
    raise exception 'invalid_date' using errcode = 'P0001';
  end if;
  if length(v_title) < 1 or length(v_title) > 80 then
    raise exception 'invalid_title' using errcode = 'P0001';
  end if;

  update public.service_history
     set event_date = p_event_date, title = v_title,
         location = nullif(btrim(coalesce(p_location, '')), ''),
         role = nullif(btrim(coalesce(p_role, '')), ''),
         notes = nullif(btrim(coalesce(p_notes, '')), '')
   where id = p_id;
end;
$$;

revoke all on function public.update_service_entry(uuid, date, text, text, text, text) from public, anon;
grant execute on function public.update_service_entry(uuid, date, text, text, text, text) to authenticated;

create function public.delete_service_entry(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_capability('edit_roster') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.service_history where id = p_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.delete_service_entry(uuid) from public, anon;
grant execute on function public.delete_service_entry(uuid) to authenticated;
