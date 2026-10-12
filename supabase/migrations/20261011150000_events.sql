-- MVA-201: calendar. Events live in the ODZ database. The public sees that an event exists
-- (title, type, times, status) through the `public_events` view; everything else needs
-- read_event_details. Cancelling is a status change, not a delete.
-- Google Calendar is NOT integrated; `external_id` is reserved for a later sync adapter.

------------------------------------------------------------------------------
-- Who may read event details: Member and above (Recruit, Prospect, Contractor excluded by default;
-- Admin can toggle it in the tier screen). Every tier had it in the first seed.
------------------------------------------------------------------------------

delete from public.tier_capabilities
where capability_key = 'read_event_details'
  and tier_id in (select id from public.tiers where name in ('Recruit', 'Prospect', 'Contractor'));

------------------------------------------------------------------------------
-- Table
------------------------------------------------------------------------------

create table public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 120),
  event_type text not null default 'Other' check (event_type in ('Game Day', 'Op', 'Training', 'Meeting', 'Other')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  location_name text check (location_name is null or length(location_name) <= 120),
  location_detail text check (location_detail is null or length(location_detail) <= 1000),
  description text check (description is null or length(description) <= 5000),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  external_id text,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  constraint events_end_after_start check (ends_at is null or ends_at > starts_at)
);

create index events_starts_at_idx on public.events (starts_at);

create function public.events_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.external_id := old.external_id;
  end if;
  return new;
end;
$$;

create trigger events_prepare
  before insert or update on public.events
  for each row execute function public.events_prepare();

-- Create / edit / cancel land in the settings audit log (titles only, never descriptions).
create function public.events_audit()
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
  elsif (new.title, new.event_type, new.starts_at, new.ends_at, new.location_name, new.location_detail, new.description)
        is distinct from
        (old.title, old.event_type, old.starts_at, old.ends_at, old.location_name, old.location_detail, old.description) then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'event_edited', new.title,
            case when new.starts_at is distinct from old.starts_at then 'start time changed' else null end);
  end if;
  return null;
end;
$$;

create trigger events_audit
  after insert or update or delete on public.events
  for each row execute function public.events_audit();

revoke all on function public.events_prepare() from public, anon, authenticated;
revoke all on function public.events_audit() from public, anon, authenticated;

------------------------------------------------------------------------------
-- Public view: existence only
------------------------------------------------------------------------------
-- Runs with the owner's rights (not security_invoker) so anon can read this view without any
-- access to `events`. It lists only these columns: no location, no description.

create view public.public_events as
  select id, title, event_type, starts_at, ends_at, status
  from public.events;

------------------------------------------------------------------------------
-- Grants and RLS
------------------------------------------------------------------------------

revoke all on public.events from anon, authenticated;
revoke all on public.public_events from anon, authenticated;
grant select on public.public_events to anon, authenticated;

grant select on public.events to authenticated;
grant insert (title, event_type, starts_at, ends_at, location_name, location_detail, description, status)
  on public.events to authenticated;
grant update (title, event_type, starts_at, ends_at, location_name, location_detail, description, status)
  on public.events to authenticated;
grant delete on public.events to authenticated;

alter table public.events enable row level security;

create policy events_select on public.events
  for select to authenticated using (public.has_capability('read_event_details'));
create policy events_insert on public.events
  for insert to authenticated with check (public.has_capability('write_events'));
create policy events_update on public.events
  for update to authenticated
  using (public.has_capability('write_events'))
  with check (public.has_capability('write_events'));
create policy events_delete on public.events
  for delete to authenticated using (public.has_capability('write_events'));
