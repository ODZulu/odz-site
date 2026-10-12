-- MVA-140 (Lord's decision, option B): split what the public may see from what members may see.
--
--   events         public fields only: anon and signed-in users read them, write_events writes them.
--   event_details  1:1 (location_name, location_detail, description): read_event_details reads,
--                  write_events writes, no grant for anon at all.
--
-- Column privileges belong to a database role, not to a capability, so a Recruit and a Member
-- (both `authenticated`) can only be told apart by row-level security. Hence two tables.
-- public_events (a SECURITY DEFINER view, the security advisor's one ERROR) is dropped: the app
-- reads `events` directly. Notifications and audit never carry details, only titles and times.

------------------------------------------------------------------------------
-- event_details, and move the existing rows
------------------------------------------------------------------------------

create table public.event_details (
  event_id uuid primary key references public.events (id) on delete cascade,
  location_name text check (location_name is null or length(location_name) <= 120),
  location_detail text check (location_detail is null or length(location_detail) <= 1000),
  description text check (description is null or length(description) <= 5000)
);

insert into public.event_details (event_id, location_name, location_detail, description)
select id, location_name, location_detail, description
from public.events
where location_name is not null or location_detail is not null or description is not null;

drop view public.public_events;

-- Audit on events no longer looks at the detail columns (they are about to go).
create or replace function public.events_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'event_created', new.title, null);
  elsif tg_op = 'DELETE' then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'event_deleted', old.title, null);
  elsif new.status is distinct from old.status then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), case when new.status = 'cancelled' then 'event_cancelled' else 'event_reinstated' end, new.title, null);
  elsif (new.title, new.event_type, new.starts_at, new.ends_at)
        is distinct from
        (old.title, old.event_type, old.starts_at, old.ends_at) then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'event_edited', new.title,
            case when new.starts_at is distinct from old.starts_at then 'start time changed' else null end);
  end if;
  return null;
end;
$$;

alter table public.events
  drop column location_name,
  drop column location_detail,
  drop column description;

------------------------------------------------------------------------------
-- Audit for detail edits (titles only, never the content)
------------------------------------------------------------------------------
-- One 'event_edited' row per transaction and event: saving the title and the details together
-- through save_event() logs once.

create function public.event_details_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  t text;
begin
  if (new.location_name, new.location_detail, new.description)
     is not distinct from (old.location_name, old.location_detail, old.description) then
    return null;
  end if;
  select title into t from public.events where id = new.event_id;
  if t is not null and not exists (
    select 1 from public.settings_audit a
    where a.event = 'event_edited' and a.target = t and a.created_at = now()
      and a.actor_id is not distinct from auth.uid()
  ) then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'event_edited', t, null);
  end if;
  return null;
end;
$$;

create trigger event_details_audit
  after update on public.event_details
  for each row execute function public.event_details_audit();

revoke all on function public.event_details_audit() from public, anon, authenticated;

------------------------------------------------------------------------------
-- Grants and row-level security
------------------------------------------------------------------------------

revoke all on public.events from anon, authenticated;
revoke all on public.event_details from anon, authenticated;

-- anon sees exactly the listing columns: never created_by or external_id.
grant select (id, title, event_type, starts_at, ends_at, status) on public.events to anon;
grant select on public.events to authenticated;
grant insert (title, event_type, starts_at, ends_at, status) on public.events to authenticated;
grant update (title, event_type, starts_at, ends_at, status) on public.events to authenticated;
grant delete on public.events to authenticated;

grant select on public.event_details to authenticated;
grant insert (event_id, location_name, location_detail, description) on public.event_details to authenticated;
grant update (location_name, location_detail, description) on public.event_details to authenticated;
grant delete on public.event_details to authenticated;

drop policy events_select on public.events;
create policy events_select on public.events
  for select to anon, authenticated using (true);
-- insert / update / delete policies (write_events) from the events migration stay as they are.

alter table public.event_details enable row level security;

create policy event_details_select on public.event_details
  for select to authenticated using (public.has_capability('read_event_details'));
create policy event_details_insert on public.event_details
  for insert to authenticated with check (public.has_capability('write_events'));
create policy event_details_update on public.event_details
  for update to authenticated
  using (public.has_capability('write_events'))
  with check (public.has_capability('write_events'));
create policy event_details_delete on public.event_details
  for delete to authenticated using (public.has_capability('write_events'));

------------------------------------------------------------------------------
-- One call for the form: the event and its details, atomically, as the caller
------------------------------------------------------------------------------
-- SECURITY INVOKER: every statement is checked by the policies above, so a caller without
-- write_events changes nothing. Not a definer function, so no advisor warning either.

create function public.save_event(
  p_id uuid,
  p_title text,
  p_event_type text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_location_name text,
  p_location_detail text,
  p_description text
)
returns uuid
language plpgsql set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_id is null then
    insert into public.events (title, event_type, starts_at, ends_at)
    values (p_title, p_event_type, p_starts_at, p_ends_at)
    returning id into v_id;
  else
    update public.events
    set title = p_title, event_type = p_event_type, starts_at = p_starts_at, ends_at = p_ends_at
    where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;

  insert into public.event_details (event_id, location_name, location_detail, description)
  values (
    v_id,
    nullif(btrim(coalesce(p_location_name, '')), ''),
    nullif(btrim(coalesce(p_location_detail, '')), ''),
    nullif(btrim(coalesce(p_description, '')), '')
  )
  on conflict (event_id) do update set
    location_name = excluded.location_name,
    location_detail = excluded.location_detail,
    description = excluded.description;

  return v_id;
end;
$$;

revoke all on function public.save_event(uuid, text, text, timestamptz, timestamptz, text, text, text) from public, anon;
grant execute on function public.save_event(uuid, text, text, timestamptz, timestamptz, text, text, text) to authenticated;
