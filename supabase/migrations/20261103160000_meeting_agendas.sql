-- MVA-245: meeting agendas. A Meeting event can carry a structured agenda, shown in layers,
-- published on purpose, and carried into the minutes afterwards.
--
--   * agendas: one per event (event_type 'Meeting'), a draft until a write_events holder publishes
--     it. publish_count and publish_log record publish and republish (who, when).
--   * agenda_items: ordered; title, planned minutes, kind (inform / discuss / vote), optional
--     presenter, notes (markdown, 3,000 characters), vote_wording (exact motion text for vote
--     items), outcome_md (filled after the meeting, copied into the minutes) and a visibility
--     level: members (default; every approved member who can read event details), command
--     (Command and Admin) or presenter (the named presenter plus Command and Admin).
--   * Presenter notes are a SEPARATE table (agenda_item_notes), Presenter level always. They have
--     to be: RLS works on rows, not columns, so a column in the item row could not be hidden from
--     members who can read the item.
--   * agenda_item_documents links existing Documents (MVA-202) to an item. The link row is visible
--     with the item; the document itself still obeys its own RLS, so a link never widens access.
--   * Draft agendas are visible only to Command and Admin (and write_events holders). Anon has no
--     grant on any of it. Enforced in RLS, not only the UI.
--   * Edits after publishing mark the changed item (edited_since_publish). A second explicit
--     publish (publish_agenda again) notifies the audience again and stamps those items
--     updated_in_publish so members see an "updated" mark.
--   * create_minutes_from_agenda() pre-fills a minutes DRAFT: item headings, vote wording, an
--     outcome line per item, and an attendee list from the RSVPs. Presenter notes and items that
--     are not Members level are left out unless Command asks for them explicitly.
--
-- The vote-item link to a motion (MVA-233) is deliberately NOT here: it is added by the live
-- meeting votes ticket (MVA-246), once both are on dev. Until then vote_wording is the record.
--
-- Additive: five new tables, new functions, and one widened check constraint on notifications
-- ('agenda' added; 'motion' is included so this migration is safe in either order with MVA-233).

------------------------------------------------------------------------------
-- Notifications: one new kind
------------------------------------------------------------------------------

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in ('reminder', 'new', 'cancelled', 'changed', 'test', 'motion', 'agenda'));

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

create table public.agendas (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references public.events (id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'published')),
  publish_count integer not null default 0,
  published_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agendas_published_consistent check ((status = 'published') = (publish_count > 0))
);

create table public.agenda_items (
  id uuid primary key default gen_random_uuid(),
  agenda_id uuid not null references public.agendas (id) on delete cascade,
  position integer not null default 0,
  title text not null check (length(btrim(title)) between 1 and 160),
  planned_minutes integer not null default 5 check (planned_minutes between 0 and 480),
  kind text not null default 'discuss' check (kind in ('inform', 'discuss', 'vote')),
  presenter_id uuid references public.profiles (id) on delete set null,
  visibility text not null default 'members' check (visibility in ('members', 'command', 'presenter')),
  notes_md text check (notes_md is null or length(notes_md) <= 3000),
  vote_wording text check (vote_wording is null or length(vote_wording) <= 1500),
  outcome_md text check (outcome_md is null or length(outcome_md) <= 2000),
  edited_since_publish boolean not null default false,
  updated_in_publish integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A presenter-level item needs someone to present it.
  constraint agenda_items_presenter_level check (visibility <> 'presenter' or presenter_id is not null)
);

create index agenda_items_agenda_idx on public.agenda_items (agenda_id, position);

create table public.agenda_item_notes (
  item_id uuid primary key references public.agenda_items (id) on delete cascade,
  presenter_notes_md text not null check (length(presenter_notes_md) <= 3000),
  updated_at timestamptz not null default now()
);

create table public.agenda_item_documents (
  item_id uuid not null references public.agenda_items (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  primary key (item_id, document_id)
);

create table public.agenda_publish_log (
  id uuid primary key default gen_random_uuid(),
  agenda_id uuid not null references public.agendas (id) on delete cascade,
  action text not null check (action in ('published', 'republished')),
  actor_id uuid,
  actor_callsign text,
  created_at timestamptz not null default now()
);

create index agenda_publish_log_agenda_idx on public.agenda_publish_log (agenda_id, created_at);

------------------------------------------------------------------------------
-- Triggers
------------------------------------------------------------------------------

-- Only a Meeting gets an agenda.
create function public.agendas_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.events e where e.id = new.event_id and e.event_type = 'Meeting') then
      raise exception 'not_a_meeting' using errcode = 'P0001';
    end if;
    new.status := 'draft';
    new.publish_count := 0;
    new.published_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger agendas_prepare
  before insert or update on public.agendas
  for each row execute function public.agendas_prepare();

-- Items: tidy the title, and mark an edit made after publishing so the republish can announce it.
-- A change to the outcome (written after the meeting) or the order is not an agenda change.
create function public.agenda_items_prepare()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  published boolean;
begin
  new.title := btrim(new.title);
  new.updated_at := now();
  select (a.status = 'published') into published from public.agendas a where a.id = new.agenda_id;
  if tg_op = 'INSERT' then
    new.edited_since_publish := coalesce(published, false);
    new.updated_in_publish := null;
  else
    new.agenda_id := old.agenda_id;
    if (new.title, new.planned_minutes, new.kind, new.presenter_id, new.visibility, new.notes_md, new.vote_wording)
       is distinct from
       (old.title, old.planned_minutes, old.kind, old.presenter_id, old.visibility, old.notes_md, old.vote_wording) then
      new.edited_since_publish := coalesce(published, false) or old.edited_since_publish;
    end if;
  end if;
  return new;
end;
$$;

create trigger agenda_items_prepare
  before insert or update on public.agenda_items
  for each row execute function public.agenda_items_prepare();

create function public.agenda_item_notes_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger agenda_item_notes_prepare
  before insert or update on public.agenda_item_notes
  for each row execute function public.agenda_item_notes_prepare();

-- The publish log is permanent.
create function public.agenda_log_immutable()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'the publish log is permanent' using errcode = '42501';
end;
$$;

create trigger agenda_publish_log_immutable
  before update or delete on public.agenda_publish_log
  for each row execute function public.agenda_log_immutable();

revoke all on function public.agendas_prepare() from public, anon, authenticated;
revoke all on function public.agenda_items_prepare() from public, anon, authenticated;
revoke all on function public.agenda_item_notes_prepare() from public, anon, authenticated;
revoke all on function public.agenda_log_immutable() from public, anon, authenticated;

------------------------------------------------------------------------------
-- Who sees what
------------------------------------------------------------------------------

-- Command and Admin, or anyone who may write events (the builders): they see drafts and every level.
create function public.agenda_manager()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.current_user_is_admin()
      or public.has_capability('write_events')
      or exists (
        select 1 from public.profiles p join public.tiers t on t.id = p.tier_id
        where p.id = auth.uid() and p.status = 'approved' and t.seat_group = 'command'
      )
$$;

create function public.agenda_visible(p_agenda uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.agendas a
    where a.id = p_agenda
      and (public.agenda_manager() or (a.status = 'published' and public.has_capability('read_event_details')))
  )
$$;

-- An item by level: Members (published, read_event_details), Command (managers only), Presenter
-- (managers, or the named presenter once published). The core takes the row's own columns so the
-- policy also works for the row being inserted (a policy that looked the row up again by id could
-- not see it yet, and "insert ... returning" would be refused).
create function public.agenda_level_visible(p_agenda uuid, p_visibility text, p_presenter uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.agendas a
    where a.id = p_agenda
      and (
        public.agenda_manager()
        or (
          a.status = 'published'
          and (
            (p_visibility = 'members' and public.has_capability('read_event_details'))
            or (p_visibility = 'presenter' and p_presenter = auth.uid() and public.current_user_is_approved())
          )
        )
      )
  )
$$;

-- The same by item id, for the tables that hang off an item.
create function public.agenda_item_visible(p_item uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.agenda_items i
    where i.id = p_item and public.agenda_level_visible(i.agenda_id, i.visibility, i.presenter_id)
  )
$$;

-- Presenter notes: managers, or the named presenter of a published agenda.
create function public.agenda_notes_visible(p_item uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.agenda_items i
    join public.agendas a on a.id = i.agenda_id
    where i.id = p_item
      and (
        public.agenda_manager()
        or (a.status = 'published' and i.presenter_id = auth.uid() and public.current_user_is_approved())
      )
  )
$$;

revoke all on function public.agenda_manager() from public, anon;
revoke all on function public.agenda_visible(uuid) from public, anon;
revoke all on function public.agenda_level_visible(uuid, text, uuid) from public, anon;
revoke all on function public.agenda_item_visible(uuid) from public, anon;
revoke all on function public.agenda_notes_visible(uuid) from public, anon;
grant execute on function public.agenda_manager() to authenticated;
grant execute on function public.agenda_visible(uuid) to authenticated;
grant execute on function public.agenda_level_visible(uuid, text, uuid) to authenticated;
grant execute on function public.agenda_item_visible(uuid) to authenticated;
grant execute on function public.agenda_notes_visible(uuid) to authenticated;

------------------------------------------------------------------------------
-- RLS and grants. Building needs write_events. Status and publish fields are RPC-only.
------------------------------------------------------------------------------

revoke all on public.agendas, public.agenda_items, public.agenda_item_notes,
  public.agenda_item_documents, public.agenda_publish_log from anon, authenticated;

grant select on public.agendas, public.agenda_items, public.agenda_item_notes,
  public.agenda_item_documents, public.agenda_publish_log to authenticated;

grant insert (event_id) on public.agendas to authenticated;
grant delete on public.agendas to authenticated;
grant insert (agenda_id, position, title, planned_minutes, kind, presenter_id, visibility, notes_md, vote_wording, outcome_md)
  on public.agenda_items to authenticated;
grant update (position, title, planned_minutes, kind, presenter_id, visibility, notes_md, vote_wording, outcome_md)
  on public.agenda_items to authenticated;
grant delete on public.agenda_items to authenticated;
grant insert (item_id, presenter_notes_md) on public.agenda_item_notes to authenticated;
grant update (presenter_notes_md) on public.agenda_item_notes to authenticated;
grant delete on public.agenda_item_notes to authenticated;
grant insert (item_id, document_id) on public.agenda_item_documents to authenticated;
grant delete on public.agenda_item_documents to authenticated;

alter table public.agendas enable row level security;
alter table public.agenda_items enable row level security;
alter table public.agenda_item_notes enable row level security;
alter table public.agenda_item_documents enable row level security;
alter table public.agenda_publish_log enable row level security;

create policy agendas_select on public.agendas
  for select to authenticated
  using (public.agenda_manager() or (status = 'published' and public.has_capability('read_event_details')));
create policy agendas_insert on public.agendas
  for insert to authenticated with check (public.has_capability('write_events'));
create policy agendas_delete on public.agendas
  for delete to authenticated using (public.has_capability('write_events'));

create policy agenda_items_select on public.agenda_items
  for select to authenticated using (public.agenda_level_visible(agenda_id, visibility, presenter_id));
create policy agenda_items_insert on public.agenda_items
  for insert to authenticated with check (public.has_capability('write_events'));
create policy agenda_items_update on public.agenda_items
  for update to authenticated
  using (public.has_capability('write_events')) with check (public.has_capability('write_events'));
create policy agenda_items_delete on public.agenda_items
  for delete to authenticated using (public.has_capability('write_events'));

create policy agenda_item_notes_select on public.agenda_item_notes
  for select to authenticated using (public.agenda_notes_visible(item_id));
create policy agenda_item_notes_insert on public.agenda_item_notes
  for insert to authenticated with check (public.has_capability('write_events'));
create policy agenda_item_notes_update on public.agenda_item_notes
  for update to authenticated
  using (public.has_capability('write_events')) with check (public.has_capability('write_events'));
create policy agenda_item_notes_delete on public.agenda_item_notes
  for delete to authenticated using (public.has_capability('write_events'));

create policy agenda_item_documents_select on public.agenda_item_documents
  for select to authenticated using (public.agenda_item_visible(item_id));
create policy agenda_item_documents_insert on public.agenda_item_documents
  for insert to authenticated with check (public.has_capability('write_events'));
create policy agenda_item_documents_delete on public.agenda_item_documents
  for delete to authenticated using (public.has_capability('write_events'));

-- Who published when: visible with the agenda.
create policy agenda_publish_log_select on public.agenda_publish_log
  for select to authenticated using (public.agenda_visible(agenda_id));
-- No insert/update/delete policy: only publish_agenda() writes it.

------------------------------------------------------------------------------
-- Publish, republish
------------------------------------------------------------------------------

create function public.publish_agenda(p_agenda uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  a public.agendas;
  ev public.events;
  n integer;
  republish boolean;
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into a from public.agendas where id = p_agenda for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  select * into ev from public.events where id = a.event_id;
  if ev.status = 'cancelled' then
    raise exception 'event_cancelled' using errcode = 'P0001';
  end if;
  republish := a.status = 'published';

  select count(*) into n from public.agenda_items where agenda_id = p_agenda;
  if n = 0 then
    raise exception 'empty_agenda' using errcode = 'P0001';
  end if;
  if republish and not exists (
    select 1 from public.agenda_items where agenda_id = p_agenda and edited_since_publish
  ) then
    raise exception 'nothing_to_publish' using errcode = 'P0001';
  end if;

  n := a.publish_count + 1;
  update public.agendas
    set status = 'published', publish_count = n, published_at = now()
  where id = p_agenda;
  -- Items edited since the last publish carry the "updated" mark for this one.
  update public.agenda_items
    set updated_in_publish = n, edited_since_publish = false
  where agenda_id = p_agenda and edited_since_publish;

  insert into public.agenda_publish_log (agenda_id, action, actor_id, actor_callsign)
  values (p_agenda, case when republish then 'republished' else 'published' end, auth.uid(),
          (select callsign from public.profiles where id = auth.uid()));

  insert into public.notifications (profile_id, kind, title, body, link)
  select r.profile_id, 'agenda',
         left(case when republish then 'Agenda updated: ' else 'Agenda published: ' end || ev.title, 200),
         case when republish then 'The agenda for this meeting changed.' else 'The agenda for this meeting is ready.' end,
         '/agenda/' || a.event_id::text
  from public.event_recipients() r;
  return n;
end;
$$;

revoke all on function public.publish_agenda(uuid) from public, anon;
grant execute on function public.publish_agenda(uuid) to authenticated;

-- Re-orders every item of an agenda in one call (the list must be exactly the agenda's items).
create function public.reorder_agenda_items(p_agenda uuid, p_order uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (select count(*) from public.agenda_items where agenda_id = p_agenda) <> coalesce(cardinality(p_order), 0)
     or exists (
       select 1 from unnest(p_order) x
       where not exists (select 1 from public.agenda_items i where i.id = x and i.agenda_id = p_agenda)
     ) then
    raise exception 'bad_order' using errcode = 'P0001';
  end if;
  update public.agenda_items i
    set position = o.ord::integer
  from unnest(p_order) with ordinality as o(id, ord)
  where i.id = o.id;
end;
$$;

revoke all on function public.reorder_agenda_items(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_agenda_items(uuid, uuid[]) to authenticated;

------------------------------------------------------------------------------
-- Minutes from the agenda
------------------------------------------------------------------------------
-- Builds a minutes DRAFT. By default it copies only Members-level items (heading, kind, vote
-- wording, outcome); presenter notes and Command/Presenter-level items come across only when the
-- caller asks. The minutes then follow normal minutes visibility (draft until published).

create function public.create_minutes_from_agenda(
  p_agenda uuid,
  p_include_presenter_notes boolean default false,
  p_include_command_items boolean default false
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  a public.agendas;
  ev public.events;
  r record;
  n integer := 0;
  md text := '';
  attendees text;
  new_id uuid;
begin
  if not (public.has_capability('write_minutes') and public.agenda_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into a from public.agendas where id = p_agenda;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  select * into ev from public.events where id = a.event_id;

  for r in
    select i.*, nt.presenter_notes_md
    from public.agenda_items i
    left join public.agenda_item_notes nt on nt.item_id = i.id
    where i.agenda_id = p_agenda
      and (i.visibility = 'members' or p_include_command_items)
    order by i.position, i.created_at
  loop
    n := n + 1;
    md := md || '## ' || n || '. ' || r.title || E'\n\n';
    md := md || '_' || case r.kind when 'vote' then 'Vote' when 'inform' then 'For information' else 'Discussion' end
             || ', ' || r.planned_minutes || ' min planned_' || E'\n\n';
    if r.kind = 'vote' and r.vote_wording is not null and btrim(r.vote_wording) <> '' then
      md := md || '**Motion:** ' || r.vote_wording || E'\n\n';
    end if;
    if p_include_presenter_notes and r.presenter_notes_md is not null then
      md := md || '**Presenter notes:** ' || r.presenter_notes_md || E'\n\n';
    end if;
    md := md || '**Outcome:** ' || coalesce(nullif(btrim(r.outcome_md), ''), '_(record the outcome)_') || E'\n\n';
  end loop;

  select string_agg('- ' || p.callsign, E'\n' order by p.callsign) into attendees
  from public.event_rsvps rs join public.profiles p on p.id = rs.profile_id
  where rs.event_id = a.event_id and rs.response = 'in';

  md := md || '## Attendees' || E'\n\n'
     || coalesce(attendees || E'\n\n_(listed from RSVPs; edit to match who attended)_', '_(list who attended)_')
     || E'\n';

  insert into public.minutes (title, meeting_date, body_md, status)
  values (left('Minutes: ' || ev.title, 160), ((ev.starts_at at time zone 'UTC') - interval '7 hours')::date, md, 'draft')
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.create_minutes_from_agenda(uuid, boolean, boolean) from public, anon;
grant execute on function public.create_minutes_from_agenda(uuid, boolean, boolean) to authenticated;
