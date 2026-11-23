-- MVA-229: event prep cadence templates. A template is an ordered list of prep meetings counted
-- back from an event ("60, 30, 14, 7 and 2 days before"); applying it to an event creates those
-- meetings as ordinary events (MVA-228's model: each has an audience, its own edit and cancel).
--
--   * Templates and steps are Command/Admin (write_events) only, readable only by them. A step has a
--     title, days before the event, a local time of day, a duration, an audience (members /
--     old_guard / command, so a Command-only prep meeting is invisible below Command like any
--     restricted event) and a topics text that becomes the meeting's description.
--   * A template can name an event type and be "automatic": every new scheduled event of that type
--     gets the cadence at once (a trigger). Retiring a template stops both.
--   * Each generated meeting links to its source event (events.source_event_id) and its step
--     (events.cadence_step_id); one meeting per event and step (unique), so applying twice never
--     duplicates. Times come from `(date + local time) at time zone tz`, so 19:00 stays 19:00 across
--     daylight saving.
--   * event_cadence_plan() says what applying would do, step by step: create, skip_past (the date is
--     already gone), update (an unedited meeting differs from the template), unchanged, leave_edited
--     (someone changed it by hand: left alone) or past. The same plan drives event_cadence_apply(),
--     so the preview and the action cannot disagree. Editing a template never touches existing
--     meetings; "re-apply" is that explicit action.
--   * When the source event's start moves, unedited future meetings shift to keep their offsets;
--     hand-edited ones are left and flagged cadence_review ("review: event date changed"). When the
--     source event is cancelled, its future meetings are cancelled (past ones stay), without one
--     notice per meeting.
--
-- Additive: columns on events, three tables' worth of new objects, triggers, functions. The two
-- series "edited" trigger functions from 20261106150000_event_series.sql are redefined so a hand-
-- edited cadence meeting is protected the same way as a series instance.

------------------------------------------------------------------------------
-- Columns
------------------------------------------------------------------------------

alter table public.events
  add column source_event_id uuid references public.events (id) on delete set null,
  add column cadence_step_id uuid,
  add column cadence_review boolean not null default false;

create table public.event_cadence_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  event_type text check (event_type is null or event_type in ('Game Day', 'Op', 'Training', 'Meeting', 'Other')),
  auto_apply boolean not null default false,
  timezone text not null default 'America/Phoenix',
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint cadence_auto_needs_type check (not auto_apply or event_type is not null)
);

create table public.event_cadence_steps (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.event_cadence_templates (id) on delete cascade,
  position integer not null check (position >= 0),
  title text not null check (length(btrim(title)) between 1 and 80),
  offset_days integer not null check (offset_days between 0 and 730),
  local_time time not null,
  duration_minutes integer not null check (duration_minutes between 15 and 1440),
  audience text not null check (audience in ('members', 'old_guard', 'command')),
  topics text check (topics is null or length(topics) <= 2000)
);

create index event_cadence_steps_template_idx on public.event_cadence_steps (template_id, position);

alter table public.events
  add constraint events_cadence_step_fk foreign key (cadence_step_id) references public.event_cadence_steps (id) on delete set null,
  add constraint events_cadence_unique unique (source_event_id, cadence_step_id);

create index events_source_idx on public.events (source_event_id) where source_event_id is not null;

alter table public.event_cadence_templates enable row level security;
alter table public.event_cadence_steps enable row level security;
revoke all on public.event_cadence_templates from anon, authenticated;
revoke all on public.event_cadence_steps from anon, authenticated;
grant select on public.event_cadence_templates to authenticated;
grant select on public.event_cadence_steps to authenticated;
create policy event_cadence_templates_select on public.event_cadence_templates
  for select to authenticated using (public.has_capability('write_events'));
create policy event_cadence_steps_select on public.event_cadence_steps
  for select to authenticated using (public.has_capability('write_events'));

------------------------------------------------------------------------------
-- A hand-edited cadence meeting is protected like a series instance.
-- Copied from 20261106150000_event_series.sql; the series_id test also accepts cadence_step_id.
------------------------------------------------------------------------------

create or replace function public.events_series_edited()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (old.series_id is not null or old.cadence_step_id is not null)
     and coalesce(current_setting('odz.series_edit', true), '') <> '1'
     and (new.title, new.event_type, new.starts_at, new.ends_at) is distinct from (old.title, old.event_type, old.starts_at, old.ends_at) then
    new.series_edited := true;
  end if;
  return new;
end;
$$;

create or replace function public.event_details_series_edited()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(current_setting('odz.series_edit', true), '') <> '1'
     and (new.location_name, new.location_detail, new.description) is distinct from (old.location_name, old.location_detail, old.description) then
    update public.events set series_edited = true
     where id = new.event_id and (series_id is not null or cadence_step_id is not null) and not series_edited;
  end if;
  return null;
end;
$$;

------------------------------------------------------------------------------
-- Offsets
------------------------------------------------------------------------------

-- When a step's meeting starts: the event's local date minus the offset, at the step's local time.
create function public.cadence_start(p_event_starts timestamptz, p_tz text, p_offset integer, p_time time)
returns timestamptz
language sql stable set search_path = ''
as $$
  select ((((p_event_starts at time zone p_tz)::date - p_offset) + p_time) at time zone p_tz)
$$;

revoke all on function public.cadence_start(timestamptz, text, integer, time) from public, anon;
grant execute on function public.cadence_start(timestamptz, text, integer, time) to authenticated;

------------------------------------------------------------------------------
-- Templates: save (create or replace the whole step list), retire
------------------------------------------------------------------------------

create function public.event_cadence_template_save(
  p_id uuid, p_name text, p_event_type text, p_auto boolean, p_timezone text, p_steps jsonb
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_tz text := coalesce(nullif(btrim(p_timezone), ''), 'America/Phoenix');
  s jsonb;
  i integer := 0;
  v_step uuid;
  v_keep uuid[] := '{}';
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 1 or length(btrim(p_name)) > 80 then
    raise exception 'invalid_name' using errcode = 'P0001';
  end if;
  if p_event_type is not null and p_event_type not in ('Game Day', 'Op', 'Training', 'Meeting', 'Other') then
    raise exception 'invalid_event_type' using errcode = 'P0001';
  end if;
  if coalesce(p_auto, false) and p_event_type is null then
    raise exception 'auto_needs_type' using errcode = 'P0001';
  end if;
  if not exists (select 1 from pg_timezone_names z where z.name = v_tz) then
    raise exception 'invalid_timezone' using errcode = 'P0001';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) < 1 or jsonb_array_length(p_steps) > 30 then
    raise exception 'invalid_steps' using errcode = 'P0001';
  end if;

  if v_id is null then
    insert into public.event_cadence_templates (name, event_type, auto_apply, timezone)
    values (btrim(p_name), p_event_type, coalesce(p_auto, false), v_tz) returning id into v_id;
  else
    update public.event_cadence_templates
       set name = btrim(p_name), event_type = p_event_type, auto_apply = coalesce(p_auto, false), timezone = v_tz
     where id = v_id and status = 'active';
    if not found then
      raise exception 'not found' using errcode = 'P0002';
    end if;
  end if;

  for s in select * from jsonb_array_elements(p_steps) loop
    if length(btrim(coalesce(s ->> 'title', ''))) < 1 or length(btrim(s ->> 'title')) > 80 then
      raise exception 'invalid_step' using errcode = 'P0001';
    end if;
    if coalesce(s ->> 'audience', '') not in ('members', 'old_guard', 'command') then
      raise exception 'invalid_step' using errcode = 'P0001';
    end if;
    begin
      if coalesce((s ->> 'offset_days')::integer, -1) not between 0 and 730
         or coalesce((s ->> 'duration_minutes')::integer, 0) not between 15 and 1440
         or (s ->> 'local_time')::time is null then
        raise exception 'invalid_step' using errcode = 'P0001';
      end if;
    exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then
      raise exception 'invalid_step' using errcode = 'P0001';
    end;
    v_step := nullif(s ->> 'id', '')::uuid;
    if v_step is not null and exists (select 1 from public.event_cadence_steps where id = v_step and template_id = v_id) then
      update public.event_cadence_steps
         set position = i, title = btrim(s ->> 'title'), offset_days = (s ->> 'offset_days')::integer,
             local_time = (s ->> 'local_time')::time, duration_minutes = (s ->> 'duration_minutes')::integer,
             audience = s ->> 'audience', topics = nullif(btrim(coalesce(s ->> 'topics', '')), '')
       where id = v_step;
    else
      insert into public.event_cadence_steps (template_id, position, title, offset_days, local_time, duration_minutes, audience, topics)
      values (v_id, i, btrim(s ->> 'title'), (s ->> 'offset_days')::integer, (s ->> 'local_time')::time,
              (s ->> 'duration_minutes')::integer, s ->> 'audience', nullif(btrim(coalesce(s ->> 'topics', '')), ''))
      returning id into v_step;
    end if;
    v_keep := v_keep || v_step;
    i := i + 1;
  end loop;
  -- Steps left out are removed; meetings already generated from them keep standing (their link clears).
  delete from public.event_cadence_steps where template_id = v_id and not (id = any (v_keep));
  return v_id;
end;
$$;

create function public.event_cadence_template_retire(p_id uuid, p_retired boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.event_cadence_templates
     set status = case when p_retired then 'retired' else 'active' end,
         auto_apply = case when p_retired then false else auto_apply end
   where id = p_id;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
end;
$$;

------------------------------------------------------------------------------
-- The plan, and the action that follows it
------------------------------------------------------------------------------

create function public.event_cadence_plan_internal(p_event uuid, p_template uuid)
returns table (
  step_id uuid, step_position integer, step_title text, action text,
  meeting_id uuid, current_starts_at timestamptz, new_starts_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  e public.events;
  t public.event_cadence_templates;
  r public.event_cadence_steps;
  m public.events;
  v_new timestamptz;
  v_title text;
  v_desc text;
  v_act text;
begin
  select * into e from public.events where id = p_event;
  select * into t from public.event_cadence_templates where id = p_template;
  if e.id is null or t.id is null then
    return;
  end if;
  for r in select * from public.event_cadence_steps where template_id = p_template order by position loop
    v_new := public.cadence_start(e.starts_at, t.timezone, r.offset_days, r.local_time);
    v_title := left(e.title || ': ' || r.title, 120);
    select * into m from public.events where source_event_id = p_event and cadence_step_id = r.id;
    if m.id is null then
      v_act := case when v_new <= now() then 'skip_past' else 'create' end;
    elsif m.starts_at <= now() then
      v_act := 'past';
    elsif m.series_edited then
      v_act := 'leave_edited';
    else
      select d.description into v_desc from public.event_details d where d.event_id = m.id;
      v_act := case
        when (m.title, m.starts_at, m.ends_at, m.audience)
             is distinct from (v_title, v_new, v_new + r.duration_minutes * interval '1 minute', r.audience)
          or v_desc is distinct from r.topics
        then 'update' else 'unchanged' end;
    end if;
    step_id := r.id; step_position := r.position; step_title := r.title; action := v_act;
    meeting_id := m.id; current_starts_at := m.starts_at; new_starts_at := v_new;
    return next;
    m := null;
  end loop;
end;
$$;

-- Preview for Command and Admin.
create function public.event_cadence_plan(p_event uuid, p_template uuid)
returns table (
  step_id uuid, step_position integer, step_title text, action text,
  meeting_id uuid, current_starts_at timestamptz, new_starts_at timestamptz
)
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query select * from public.event_cadence_plan_internal(p_event, p_template);
end;
$$;

-- Does what the plan says (creates and updates), and returns the plan so the screen can report
-- what was skipped. Internal: the caller has already been authorised.
create function public.event_cadence_run(p_event uuid, p_template uuid)
returns table (step_title text, action text)
language plpgsql security definer set search_path = ''
as $$
declare
  p record;
  e public.events;
  t public.event_cadence_templates;
  r public.event_cadence_steps;
  v_id uuid;
  v_prev text := coalesce(current_setting('odz.series_edit', true), '');
begin
  select * into e from public.events where id = p_event;
  select * into t from public.event_cadence_templates where id = p_template;
  perform set_config('odz.series_edit', '1', true);
  for p in select * from public.event_cadence_plan_internal(p_event, p_template) loop
    select * into r from public.event_cadence_steps where id = p.step_id;
    if p.action = 'create' then
      insert into public.events (title, event_type, starts_at, ends_at, audience, source_event_id, cadence_step_id)
      values (left(e.title || ': ' || r.title, 120), 'Meeting', p.new_starts_at,
              p.new_starts_at + r.duration_minutes * interval '1 minute', r.audience, p_event, r.id)
      returning id into v_id;
      if r.topics is not null then
        insert into public.event_details (event_id, description) values (v_id, r.topics);
      end if;
    elsif p.action = 'update' then
      update public.events
         set title = left(e.title || ': ' || r.title, 120), starts_at = p.new_starts_at,
             ends_at = p.new_starts_at + r.duration_minutes * interval '1 minute', audience = r.audience
       where id = p.meeting_id;
      insert into public.event_details (event_id, description) values (p.meeting_id, r.topics)
      on conflict (event_id) do update set description = excluded.description;
    end if;
    step_title := p.step_title;
    action := p.action;
    return next;
  end loop;
  perform set_config('odz.series_edit', v_prev, true);
end;
$$;

create function public.event_cadence_apply(p_event uuid, p_template uuid)
returns table (step_title text, action text)
language plpgsql security definer set search_path = ''
as $$
declare
  e public.events;
  t public.event_cadence_templates;
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into e from public.events where id = p_event;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if e.status <> 'scheduled' then
    raise exception 'not_scheduled' using errcode = 'P0001';
  end if;
  select * into t from public.event_cadence_templates where id = p_template;
  if not found or t.status <> 'active' then
    raise exception 'template_retired' using errcode = 'P0001';
  end if;
  return query select * from public.event_cadence_run(p_event, p_template);
end;
$$;

create function public.event_cadence_review_done(p_event uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.events set cadence_review = false where id = p_event;
end;
$$;

------------------------------------------------------------------------------
-- Triggers: automatic apply, date changes, cancellation
------------------------------------------------------------------------------

create function public.events_cadence_auto()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  t record;
begin
  if new.series_id is null and new.cadence_step_id is null and new.status = 'scheduled' then
    for t in
      select id from public.event_cadence_templates
      where status = 'active' and auto_apply and event_type = new.event_type
    loop
      perform public.event_cadence_run(new.id, t.id);
    end loop;
  end if;
  return null;
end;
$$;

create trigger events_cadence_auto
  after insert on public.events
  for each row execute function public.events_cadence_auto();

create function public.events_cadence_follow()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  m record;
  v_new timestamptz;
  v_prev text := coalesce(current_setting('odz.series_edit', true), '');
begin
  perform set_config('odz.series_edit', '1', true);
  if new.starts_at is distinct from old.starts_at then
    for m in
      select e.id, e.series_edited, e.starts_at, e.ends_at, s.offset_days, s.local_time, s.duration_minutes, t.timezone
      from public.events e
      left join public.event_cadence_steps s on s.id = e.cadence_step_id
      left join public.event_cadence_templates t on t.id = s.template_id
      where e.source_event_id = new.id and e.status = 'scheduled' and e.starts_at > now()
    loop
      if m.series_edited or m.offset_days is null then
        update public.events set cadence_review = true where id = m.id;
      else
        v_new := public.cadence_start(new.starts_at, m.timezone, m.offset_days, m.local_time);
        update public.events set starts_at = v_new, ends_at = v_new + m.duration_minutes * interval '1 minute' where id = m.id;
      end if;
    end loop;
  end if;
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update public.events set status = 'cancelled'
     where source_event_id = new.id and status = 'scheduled' and starts_at > now();
  end if;
  perform set_config('odz.series_edit', v_prev, true);
  return null;
end;
$$;

create trigger events_cadence_follow
  after update of starts_at, status on public.events
  for each row execute function public.events_cadence_follow();

------------------------------------------------------------------------------
-- Grants
------------------------------------------------------------------------------

revoke all on function public.event_cadence_template_save(uuid, text, text, boolean, text, jsonb) from public, anon;
revoke all on function public.event_cadence_template_retire(uuid, boolean) from public, anon;
revoke all on function public.event_cadence_plan_internal(uuid, uuid) from public, anon, authenticated;
revoke all on function public.event_cadence_plan(uuid, uuid) from public, anon;
revoke all on function public.event_cadence_run(uuid, uuid) from public, anon, authenticated;
revoke all on function public.event_cadence_apply(uuid, uuid) from public, anon;
revoke all on function public.event_cadence_review_done(uuid) from public, anon;
revoke all on function public.events_cadence_auto() from public, anon, authenticated;
revoke all on function public.events_cadence_follow() from public, anon, authenticated;
grant execute on function public.event_cadence_template_save(uuid, text, text, boolean, text, jsonb) to authenticated;
grant execute on function public.event_cadence_template_retire(uuid, boolean) to authenticated;
grant execute on function public.event_cadence_plan(uuid, uuid) to authenticated;
grant execute on function public.event_cadence_apply(uuid, uuid) to authenticated;
grant execute on function public.event_cadence_review_done(uuid) to authenticated;
