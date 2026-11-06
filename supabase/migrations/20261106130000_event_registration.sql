-- MVA-231: event registration and Command attendance confirmation (feeds service records).
--
-- HOW REGISTRATION COEXISTS WITH RSVP / READINESS (MVA-142) -- the choice the ticket asks for:
--   Registration is a NEW table (event_registrations), not a layer on event_rsvps. An event has
--   exactly one of the two modes, decided by whether it has a row in event_registration_settings:
--     * no settings row  -> the existing RSVP (In / Out / TBD) and readiness meter, unchanged;
--     * a settings row   -> registration. The RSVP policies below refuse new or changed RSVPs for
--                           such an event, and the app shows only the registration panel.
--   So an event can never show two conflicting "going" states. Existing RSVP rows on an event that
--   later switches to registration are left alone (and hidden); nothing is deleted or rewritten.
--   Events promoted from an opportunity (MVA-230) start with registration on.
--
-- Registration
--   * Settings per event: opens_at (default now), optional closes_at, optional capacity, and a
--     withdraw cutoff (default 7 days before the start, editable by Command).
--   * A member registers or withdraws. Over capacity they join an ordered waitlist (by the time
--     they asked) and are promoted automatically when a place opens, with an in-app notification.
--   * Withdrawal is free until the cutoff. After it the member asks (state withdrawal_requested,
--     still holding their place) and Command approves or declines; both are logged. That state is
--     what the event treasury follow-up reads.
--   * Command can register a member regardless of the window or capacity, with a reason (logged).
--   * Who sees what: any member who can read event details sees the counts and their own state;
--     the list of registrants (callsign, state, when) is for registrants and Old Guard / Command /
--     Admin; attendance results (and no-show / excused counts) for Command-side only, except a
--     member's own. Anon sees nothing. All writes are SECURITY DEFINER RPCs.
--
-- Attendance
--   * After the event ends, Command (the Command tier or write_events; Admin passes) marks each
--     registrant Attended, No-show or Excused, adds walk-ins (unregistered, Attended, reason
--     required), and then confirms. Confirming needs every registrant marked, locks the marks and
--     sets the event status to Completed (new status; events.status widened).
--   * Attended writes a service_history row (source 'app'; MVA-210) and remembers its id;
--     changing the mark away from Attended deletes that row. After confirmation a change needs a
--     reason and is logged with before and after.
--
-- Additive only: three tables, new functions, widened checks (events.status, notifications.kind),
-- two redefined functions (events_audit and opportunity_promote, each copied from its newest
-- definition, named below) and two RSVP policies recreated with one extra condition.

------------------------------------------------------------------------------
-- Widened checks
------------------------------------------------------------------------------

alter table public.events drop constraint events_status_check;
alter table public.events
  add constraint events_status_check check (status in ('scheduled', 'cancelled', 'completed'));

-- List copied from 20261106120000_event_opportunities.sql (newest), plus 'registration'.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in ('reminder', 'new', 'cancelled', 'changed', 'test', 'motion', 'agenda', 'opportunity', 'registration'));

-- Copied from 20261011210000_event_details.sql (newest definition), with a completed branch so a
-- confirmation is not logged as a reinstatement.
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
    values (auth.uid(),
            case new.status when 'cancelled' then 'event_cancelled' when 'completed' then 'event_completed' else 'event_reinstated' end,
            new.title, null);
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

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

create table public.event_registration_settings (
  event_id uuid primary key references public.events (id) on delete cascade,
  opens_at timestamptz not null default now(),
  closes_at timestamptz,
  capacity integer check (capacity is null or capacity between 1 and 1000),
  withdraw_cutoff_at timestamptz not null,
  attendance_confirmed_at timestamptz,
  attendance_confirmed_by uuid,
  created_at timestamptz not null default now(),
  constraint registration_window check (closes_at is null or closes_at > opens_at)
);

create table public.event_registrations (
  event_id uuid not null references public.events (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  state text not null check (state in ('registered', 'waitlisted', 'withdrawal_requested', 'withdrawn')),
  registered_at timestamptz not null default now(),
  withdraw_requested_at timestamptz,
  attendance text check (attendance is null or attendance in ('attended', 'no_show', 'excused')),
  attendance_by uuid,
  attendance_at timestamptz,
  walk_in boolean not null default false,
  walk_in_reason text check (walk_in_reason is null or length(walk_in_reason) <= 500),
  service_entry_id uuid references public.service_history (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (event_id, profile_id)
);

create index event_registrations_profile_idx on public.event_registrations (profile_id);

-- Append-only record of overrides, withdrawal decisions and attendance changes. The member is
-- not a foreign key: the record outlives them. Rows can never be edited; no role can delete them
-- either (no grant), and they go only when the whole event is deleted (cascade).
create table public.event_registration_log (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  profile_id uuid,
  actor_id uuid,
  action text not null,
  detail text check (detail is null or length(detail) <= 600),
  created_at timestamptz not null default now()
);

create index event_registration_log_event_idx on public.event_registration_log (event_id, created_at);

create function public.event_registration_log_immutable()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'the registration log is append-only' using errcode = '42501';
end;
$$;

create trigger event_registration_log_immutable
  before update on public.event_registration_log
  for each row execute function public.event_registration_log_immutable();

revoke all on function public.event_registration_log_immutable() from public, anon, authenticated;

------------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------------

-- Old Guard, Command, Admin (opportunity_can_see_names, MVA-230) or a write_events holder.
create function public.registration_privileged()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.opportunity_can_see_names() or public.has_capability('write_events')
$$;

-- Command tier or write_events (Admin passes has_capability): who may mark attendance.
create function public.registration_can_confirm()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.has_capability('write_events')
     or exists (
       select 1 from public.profiles p join public.tiers t on t.id = p.tier_id
       where p.id = auth.uid() and p.status = 'approved' and t.seat_group = 'command'
     )
$$;

-- Places taken: registered or asking to withdraw (they still hold the place). Walk-ins are not
-- registrants and never count against capacity.
create function public.registration_taken(p_event uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer from public.event_registrations r
  where r.event_id = p_event and not r.walk_in and r.state in ('registered', 'withdrawal_requested')
$$;

create function public.registration_log_add(p_event uuid, p_profile uuid, p_action text, p_detail text)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.event_registration_log (event_id, profile_id, actor_id, action, detail)
  values (p_event, p_profile, auth.uid(), p_action, left(p_detail, 600))
$$;

create function public.registration_notify(p_event uuid, p_profile uuid, p_title text, p_body text)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.notifications (profile_id, kind, title, body, link)
  select p.id, 'registration', left(p_title, 200), left(p_body, 300), '/calendar'
  from public.profiles p
  where p.id = p_profile and p.status = 'approved'
$$;

-- Promotes waitlisted members, in the order they asked, into any free places. Called whenever a
-- place may have opened (withdrawal, approval, capacity raised).
create function public.registration_fill(p_event uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s public.event_registration_settings;
  v_title text;
  r record;
begin
  select * into s from public.event_registration_settings where event_id = p_event;
  if not found or s.capacity is null then
    return;
  end if;
  select title into v_title from public.events where id = p_event;
  for r in
    select profile_id from public.event_registrations
    where event_id = p_event and state = 'waitlisted'
    order by registered_at, profile_id
    limit greatest(s.capacity - public.registration_taken(p_event), 0)
  loop
    update public.event_registrations set state = 'registered', updated_at = now()
     where event_id = p_event and profile_id = r.profile_id;
    perform public.registration_log_add(p_event, r.profile_id, 'waitlist_promoted', null);
    perform public.registration_notify(p_event, r.profile_id, 'You are in: ' || v_title,
                                       'A place opened and you moved off the waitlist.');
  end loop;
end;
$$;

revoke all on function public.registration_privileged() from public, anon;
revoke all on function public.registration_can_confirm() from public, anon;
revoke all on function public.registration_taken(uuid) from public, anon, authenticated;
revoke all on function public.registration_log_add(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.registration_notify(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.registration_fill(uuid) from public, anon, authenticated;
grant execute on function public.registration_privileged() to authenticated;
grant execute on function public.registration_can_confirm() to authenticated;

------------------------------------------------------------------------------
-- RLS and grants (reads only; every write is an RPC)
------------------------------------------------------------------------------

alter table public.event_registration_settings enable row level security;
alter table public.event_registrations enable row level security;
alter table public.event_registration_log enable row level security;

revoke all on public.event_registration_settings from anon, authenticated;
revoke all on public.event_registrations from anon, authenticated;
revoke all on public.event_registration_log from anon, authenticated;
grant select on public.event_registration_settings to authenticated;
grant select on public.event_registrations to authenticated;
grant select on public.event_registration_log to authenticated;

create policy event_registration_settings_select on public.event_registration_settings
  for select to authenticated using (public.has_capability('read_event_details'));

-- Your own row; everyone's for Old Guard, Command and Admin. (Other registrants see the list
-- through event_registrants(), never through the table.)
create policy event_registrations_select on public.event_registrations
  for select to authenticated
  using (
    public.has_capability('read_event_details')
    and (profile_id = auth.uid() or public.registration_privileged())
  );

create policy event_registration_log_select on public.event_registration_log
  for select to authenticated using (public.registration_privileged());

------------------------------------------------------------------------------
-- One "going" state per event: RSVPs are refused once an event uses registration.
-- Policies copied from 20261011180000_hq_panels.sql (newest), plus the one extra condition.
------------------------------------------------------------------------------

drop policy event_rsvps_insert on public.event_rsvps;
create policy event_rsvps_insert on public.event_rsvps
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and public.has_capability('read_event_details')
    and exists (select 1 from public.events e where e.id = event_id and e.starts_at > now() and e.status = 'scheduled')
    and not exists (select 1 from public.event_registration_settings s where s.event_id = event_rsvps.event_id)
  );

drop policy event_rsvps_update on public.event_rsvps;
create policy event_rsvps_update on public.event_rsvps
  for update to authenticated
  using (
    profile_id = (select auth.uid())
    and exists (select 1 from public.events e where e.id = event_id and e.starts_at > now() and e.status = 'scheduled')
    and not exists (select 1 from public.event_registration_settings s where s.event_id = event_rsvps.event_id)
  )
  with check (profile_id = (select auth.uid()));

------------------------------------------------------------------------------
-- Command: switch registration on / change its settings
------------------------------------------------------------------------------

create function public.event_registration_configure(
  p_event uuid,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_capacity integer,
  p_cutoff_at timestamptz
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  e public.events;
  s public.event_registration_settings;
  v_opens timestamptz;
  v_cutoff timestamptz;
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
  if p_capacity is not null and (p_capacity < 1 or p_capacity > 1000) then
    raise exception 'invalid_capacity' using errcode = 'P0001';
  end if;
  select * into s from public.event_registration_settings where event_id = p_event for update;
  v_opens := coalesce(p_opens_at, s.opens_at, now());
  v_cutoff := coalesce(p_cutoff_at, s.withdraw_cutoff_at, e.starts_at - interval '7 days');
  if p_closes_at is not null and p_closes_at <= v_opens then
    raise exception 'invalid_window' using errcode = 'P0001';
  end if;
  if v_cutoff > e.starts_at then
    raise exception 'invalid_cutoff' using errcode = 'P0001';
  end if;
  if s.event_id is not null and s.attendance_confirmed_at is not null then
    raise exception 'confirmed' using errcode = 'P0001';
  end if;

  insert into public.event_registration_settings (event_id, opens_at, closes_at, capacity, withdraw_cutoff_at)
  values (p_event, v_opens, p_closes_at, p_capacity, v_cutoff)
  on conflict (event_id) do update
    set opens_at = excluded.opens_at, closes_at = excluded.closes_at,
        capacity = excluded.capacity, withdraw_cutoff_at = excluded.withdraw_cutoff_at;
  perform public.registration_log_add(p_event, null, case when s.event_id is null then 'enabled' else 'configured' end, null);
  perform public.registration_fill(p_event);
end;
$$;

------------------------------------------------------------------------------
-- Members: register and withdraw
------------------------------------------------------------------------------

create function public.event_register(p_event uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  e public.events;
  s public.event_registration_settings;
  r public.event_registrations;
  v_state text;
begin
  if not public.has_capability('read_event_details') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into s from public.event_registration_settings where event_id = p_event for update;
  if not found then
    raise exception 'registration_off' using errcode = 'P0001';
  end if;
  select * into e from public.events where id = p_event;
  if e.status <> 'scheduled' or e.starts_at <= now() then
    raise exception 'closed' using errcode = 'P0001';
  end if;
  if now() < s.opens_at then
    raise exception 'not_open' using errcode = 'P0001';
  end if;
  if s.closes_at is not null and now() >= s.closes_at then
    raise exception 'closed' using errcode = 'P0001';
  end if;
  select * into r from public.event_registrations where event_id = p_event and profile_id = auth.uid();
  if found and r.state <> 'withdrawn' then
    raise exception 'already_registered' using errcode = 'P0001';
  end if;

  v_state := case when s.capacity is null or public.registration_taken(p_event) < s.capacity then 'registered' else 'waitlisted' end;
  if found then
    update public.event_registrations
       set state = v_state, registered_at = now(), withdraw_requested_at = null, attendance = null,
           attendance_by = null, attendance_at = null, updated_at = now()
     where event_id = p_event and profile_id = auth.uid();
  else
    insert into public.event_registrations (event_id, profile_id, state) values (p_event, auth.uid(), v_state);
  end if;
  return v_state;
end;
$$;

create function public.event_withdraw(p_event uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  e public.events;
  s public.event_registration_settings;
  r public.event_registrations;
begin
  if not public.has_capability('read_event_details') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into s from public.event_registration_settings where event_id = p_event for update;
  if not found then
    raise exception 'registration_off' using errcode = 'P0001';
  end if;
  select * into e from public.events where id = p_event;
  if e.status <> 'scheduled' or e.starts_at <= now() then
    raise exception 'closed' using errcode = 'P0001';
  end if;
  select * into r from public.event_registrations where event_id = p_event and profile_id = auth.uid() for update;
  if not found or r.state = 'withdrawn' then
    raise exception 'not_registered' using errcode = 'P0001';
  end if;
  if r.state = 'withdrawal_requested' then
    raise exception 'already_requested' using errcode = 'P0001';
  end if;

  if r.state = 'waitlisted' or now() < s.withdraw_cutoff_at then
    update public.event_registrations set state = 'withdrawn', updated_at = now()
     where event_id = p_event and profile_id = auth.uid();
    perform public.registration_fill(p_event);
    return 'withdrawn';
  end if;
  -- After the cutoff: ask. The member keeps the place until Command decides.
  update public.event_registrations
     set state = 'withdrawal_requested', withdraw_requested_at = now(), updated_at = now()
   where event_id = p_event and profile_id = auth.uid();
  perform public.registration_log_add(p_event, auth.uid(), 'withdrawal_requested', null);
  return 'withdrawal_requested';
end;
$$;

------------------------------------------------------------------------------
-- Command: decide a withdrawal request; register someone past the window or capacity
------------------------------------------------------------------------------

create function public.event_withdrawal_decide(p_event uuid, p_member uuid, p_approve boolean, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.event_registrations;
  v_title text;
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.event_registration_settings where event_id = p_event for update;
  select * into r from public.event_registrations where event_id = p_event and profile_id = p_member for update;
  if not found or r.state <> 'withdrawal_requested' then
    raise exception 'no_request' using errcode = 'P0001';
  end if;
  select title into v_title from public.events where id = p_event;
  if p_approve then
    update public.event_registrations set state = 'withdrawn', updated_at = now()
     where event_id = p_event and profile_id = p_member;
    perform public.registration_log_add(p_event, p_member, 'withdrawal_approved', p_note);
    perform public.registration_notify(p_event, p_member, 'Withdrawal approved: ' || v_title, 'Command approved your withdrawal.');
    perform public.registration_fill(p_event);
  else
    update public.event_registrations set state = 'registered', updated_at = now()
     where event_id = p_event and profile_id = p_member;
    perform public.registration_log_add(p_event, p_member, 'withdrawal_declined', p_note);
    perform public.registration_notify(p_event, p_member, 'Withdrawal declined: ' || v_title, 'You are still registered.');
  end if;
end;
$$;

create function public.event_register_member(p_event uuid, p_member uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  e public.events;
  r public.event_registrations;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;
  perform 1 from public.event_registration_settings where event_id = p_event for update;
  if not found then
    raise exception 'registration_off' using errcode = 'P0001';
  end if;
  select * into e from public.events where id = p_event;
  if e.status <> 'scheduled' then
    raise exception 'closed' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where id = p_member and status = 'approved') then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into r from public.event_registrations where event_id = p_event and profile_id = p_member for update;
  if found and r.state in ('registered', 'withdrawal_requested') then
    raise exception 'already_registered' using errcode = 'P0001';
  end if;
  if found then
    update public.event_registrations
       set state = 'registered', registered_at = now(), withdraw_requested_at = null, updated_at = now()
     where event_id = p_event and profile_id = p_member;
  else
    insert into public.event_registrations (event_id, profile_id, state) values (p_event, p_member, 'registered');
  end if;
  perform public.registration_log_add(p_event, p_member, 'override_registered', v_reason);
  perform public.registration_notify(p_event, p_member, 'Registered: ' || e.title, 'Command registered you for this event.');
end;
$$;

------------------------------------------------------------------------------
-- Reads
------------------------------------------------------------------------------

-- One row (none when registration is off): settings, counts, and the caller's own state.
create function public.event_registration_info(p_event uuid)
returns table (
  opens_at timestamptz, closes_at timestamptz, capacity integer, withdraw_cutoff_at timestamptz,
  confirmed boolean, registered_count integer, waitlist_count integer,
  no_show_count integer, excused_count integer, attended_count integer,
  unmarked_count integer, withdrawal_requests integer,
  my_state text, my_attendance text, my_position integer
)
language plpgsql security definer set search_path = ''
as $$
declare
  s public.event_registration_settings;
  priv boolean;
begin
  if not public.has_capability('read_event_details') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into s from public.event_registration_settings where event_id = p_event;
  if not found then
    return;
  end if;
  priv := public.registration_privileged();
  return query
    select s.opens_at, s.closes_at, s.capacity, s.withdraw_cutoff_at,
      s.attendance_confirmed_at is not null,
      public.registration_taken(p_event),
      (select count(*)::integer from public.event_registrations r where r.event_id = p_event and r.state = 'waitlisted'),
      case when priv then (select count(*)::integer from public.event_registrations r where r.event_id = p_event and r.attendance = 'no_show') end,
      case when priv then (select count(*)::integer from public.event_registrations r where r.event_id = p_event and r.attendance = 'excused') end,
      case when priv then (select count(*)::integer from public.event_registrations r where r.event_id = p_event and r.attendance = 'attended') end,
      case when priv then (select count(*)::integer from public.event_registrations r
                            where r.event_id = p_event and not r.walk_in and r.state in ('registered', 'withdrawal_requested') and r.attendance is null) end,
      case when priv then (select count(*)::integer from public.event_registrations r where r.event_id = p_event and r.state = 'withdrawal_requested') end,
      (select r.state from public.event_registrations r where r.event_id = p_event and r.profile_id = auth.uid()),
      (select r.attendance from public.event_registrations r where r.event_id = p_event and r.profile_id = auth.uid()
         and s.attendance_confirmed_at is not null),
      (select x.pos::integer from (
         select r.profile_id, row_number() over (order by r.registered_at, r.profile_id) as pos
         from public.event_registrations r where r.event_id = p_event and r.state = 'waitlisted'
       ) x where x.profile_id = auth.uid());
end;
$$;

-- The list: registrants (and Old Guard, Command, Admin). Attendance is for the Command side only.
create function public.event_registrants(p_event uuid)
returns table (profile_id uuid, callsign text, state text, registered_at timestamptz, attendance text, waitlist_position integer, walk_in boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  priv boolean;
begin
  if not public.has_capability('read_event_details') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  priv := public.registration_privileged();
  if not priv and not exists (
    select 1 from public.event_registrations r
    where r.event_id = p_event and r.profile_id = auth.uid() and r.state in ('registered', 'waitlisted', 'withdrawal_requested')
  ) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select r.profile_id, p.callsign, r.state, r.registered_at,
           case when priv then r.attendance end,
           case when r.state = 'waitlisted'
                then (row_number() over (partition by (r.state = 'waitlisted') order by r.registered_at, r.profile_id))::integer end,
           r.walk_in
    from public.event_registrations r
    join public.profiles p on p.id = r.profile_id
    where r.event_id = p_event
      and (priv or (r.state <> 'withdrawn' and not r.walk_in))
    order by (r.state = 'waitlisted'), r.registered_at, r.profile_id;
end;
$$;

------------------------------------------------------------------------------
-- Attendance
------------------------------------------------------------------------------

-- Writes or removes the service-history entry for one attendee (MVA-210's table; source 'app').
create function public.registration_sync_service_entry(p_event uuid, p_member uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.event_registrations;
  e public.events;
  v_loc text;
  v_id uuid;
begin
  select * into r from public.event_registrations where event_id = p_event and profile_id = p_member;
  select * into e from public.events where id = p_event;
  if r.attendance = 'attended' and r.service_entry_id is null then
    select location_name into v_loc from public.event_details where event_id = p_event;
    insert into public.service_history (profile_id, event_date, title, location, source, created_by)
    values (p_member, ((e.starts_at at time zone 'UTC') - interval '7 hours')::date, left(e.title, 80),
            nullif(left(coalesce(v_loc, ''), 80), ''), 'app', auth.uid())
    returning id into v_id;
    update public.event_registrations set service_entry_id = v_id where event_id = p_event and profile_id = p_member;
  elsif r.attendance is distinct from 'attended' and r.service_entry_id is not null then
    delete from public.service_history where id = r.service_entry_id;
    update public.event_registrations set service_entry_id = null where event_id = p_event and profile_id = p_member;
  end if;
end;
$$;

revoke all on function public.registration_sync_service_entry(uuid, uuid) from public, anon, authenticated;

create function public.event_attendance_set(p_event uuid, p_member uuid, p_result text, p_reason text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  e public.events;
  s public.event_registration_settings;
  r public.event_registrations;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.registration_can_confirm() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_result is not null and p_result not in ('attended', 'no_show', 'excused') then
    raise exception 'invalid_result' using errcode = 'P0001';
  end if;
  select * into s from public.event_registration_settings where event_id = p_event for update;
  if not found then
    raise exception 'registration_off' using errcode = 'P0001';
  end if;
  select * into e from public.events where id = p_event;
  if e.status = 'cancelled' then
    raise exception 'closed' using errcode = 'P0001';
  end if;
  if coalesce(e.ends_at, e.starts_at) >= now() then
    raise exception 'not_ended' using errcode = 'P0001';
  end if;
  select * into r from public.event_registrations where event_id = p_event and profile_id = p_member for update;
  if not found or (r.state in ('waitlisted', 'withdrawn') and not r.walk_in) then
    raise exception 'not_a_registrant' using errcode = 'P0001';
  end if;
  if s.attendance_confirmed_at is not null and (length(v_reason) < 3 or length(v_reason) > 500) then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;

  update public.event_registrations
     set attendance = p_result, attendance_by = auth.uid(), attendance_at = now(), updated_at = now()
   where event_id = p_event and profile_id = p_member;
  perform public.registration_sync_service_entry(p_event, p_member);
  if s.attendance_confirmed_at is not null then
    perform public.registration_log_add(p_event, p_member, 'attendance_corrected',
      coalesce(r.attendance, 'unmarked') || ' -> ' || coalesce(p_result, 'unmarked') || ': ' || v_reason);
  else
    perform public.registration_log_add(p_event, p_member, 'attendance_marked',
      coalesce(r.attendance, 'unmarked') || ' -> ' || coalesce(p_result, 'unmarked'));
  end if;
end;
$$;

-- Someone who came without registering: counted Attended, reason required.
create function public.event_attendance_walkin(p_event uuid, p_member uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  e public.events;
  r public.event_registrations;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.registration_can_confirm() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;
  perform 1 from public.event_registration_settings where event_id = p_event for update;
  if not found then
    raise exception 'registration_off' using errcode = 'P0001';
  end if;
  select * into e from public.events where id = p_event;
  if e.status = 'cancelled' then
    raise exception 'closed' using errcode = 'P0001';
  end if;
  if coalesce(e.ends_at, e.starts_at) >= now() then
    raise exception 'not_ended' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where id = p_member and status = 'approved') then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into r from public.event_registrations where event_id = p_event and profile_id = p_member for update;
  if found and r.state <> 'withdrawn' then
    raise exception 'already_registered' using errcode = 'P0001';
  end if;
  if found then
    update public.event_registrations
       set state = 'registered', walk_in = true, walk_in_reason = v_reason, attendance = 'attended',
           attendance_by = auth.uid(), attendance_at = now(), updated_at = now()
     where event_id = p_event and profile_id = p_member;
  else
    insert into public.event_registrations (event_id, profile_id, state, walk_in, walk_in_reason, attendance, attendance_by, attendance_at)
    values (p_event, p_member, 'registered', true, v_reason, 'attended', auth.uid(), now());
  end if;
  perform public.registration_sync_service_entry(p_event, p_member);
  perform public.registration_log_add(p_event, p_member, 'walk_in', v_reason);
end;
$$;

-- Locks the marks and completes the event. Every registrant must be marked first.
create function public.event_attendance_confirm(p_event uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  e public.events;
  s public.event_registration_settings;
begin
  if not public.registration_can_confirm() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into s from public.event_registration_settings where event_id = p_event for update;
  if not found then
    raise exception 'registration_off' using errcode = 'P0001';
  end if;
  select * into e from public.events where id = p_event;
  if e.status = 'cancelled' then
    raise exception 'closed' using errcode = 'P0001';
  end if;
  if coalesce(e.ends_at, e.starts_at) >= now() then
    raise exception 'not_ended' using errcode = 'P0001';
  end if;
  if s.attendance_confirmed_at is not null then
    raise exception 'confirmed' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.event_registrations r
    where r.event_id = p_event and not r.walk_in and r.state in ('registered', 'withdrawal_requested') and r.attendance is null
  ) then
    raise exception 'unmarked' using errcode = 'P0001';
  end if;
  update public.event_registration_settings
     set attendance_confirmed_at = now(), attendance_confirmed_by = auth.uid()
   where event_id = p_event;
  update public.events set status = 'completed' where id = p_event and status = 'scheduled';
  perform public.registration_log_add(p_event, null, 'attendance_confirmed', null);
end;
$$;

------------------------------------------------------------------------------
-- Promotion from an opportunity now starts registration (default window: open now, no close,
-- no capacity, cutoff 7 days before the start). Copied from 20261106120000_event_opportunities.sql
-- (newest definition) with the settings insert added.
------------------------------------------------------------------------------

create or replace function public.opportunity_promote(p_opportunity uuid, p_event_type text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  o public.opportunities;
  v_event uuid;
  v_desc text;
  v_start timestamptz;
begin
  if not (public.has_capability('manage_opportunities') and public.has_capability('write_events')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_event_type is null or p_event_type not in ('Game Day', 'Op', 'Training', 'Meeting', 'Other') then
    raise exception 'invalid_event_type' using errcode = 'P0001';
  end if;
  perform public.opportunity_expire();
  select * into o from public.opportunities where id = p_opportunity for update;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if o.status <> 'open' then
    raise exception 'not_open' using errcode = 'P0001';
  end if;

  v_desc := concat_ws(E'\n',
    nullif(btrim(coalesce(o.notes, '')), ''),
    case when o.host is not null then 'Host: ' || o.host end,
    case when o.source_url is not null then 'Source: ' || o.source_url end,
    case when o.est_cost_cents is not null then 'Estimated cost per person: $' || to_char(o.est_cost_cents / 100.0, 'FM999999990.00') end
  );
  v_start := (o.starts_on::timestamp + interval '7 hours') at time zone 'UTC';

  v_event := public.save_event(
    null,
    o.title,
    p_event_type,
    v_start,
    case when o.ends_on is not null
         then (o.ends_on::timestamp + interval '23 hours 59 minutes' + interval '7 hours') at time zone 'UTC' end,
    o.location_text,
    null,
    nullif(left(v_desc, 5000), '')
  );

  -- Registration on from the start (MVA-231). Nobody is registered automatically.
  insert into public.event_registration_settings (event_id, opens_at, withdraw_cutoff_at)
  values (v_event, now(), v_start - interval '7 days');

  update public.opportunities
     set status = 'promoted', event_id = v_event, decided_by = auth.uid(), decided_at = now()
   where id = p_opportunity;

  perform public.opportunity_notify(p_opportunity, 'Now an event: ' || o.title,
                                    'Registration is open.', array['In', 'Maybe']);
  insert into public.settings_audit (actor_id, event, target, detail)
  values (auth.uid(), 'opportunity_promoted', o.title, null);
  return v_event;
end;
$$;

------------------------------------------------------------------------------
-- Grants
------------------------------------------------------------------------------

revoke all on function public.event_registration_configure(uuid, timestamptz, timestamptz, integer, timestamptz) from public, anon;
revoke all on function public.event_register(uuid) from public, anon;
revoke all on function public.event_withdraw(uuid) from public, anon;
revoke all on function public.event_withdrawal_decide(uuid, uuid, boolean, text) from public, anon;
revoke all on function public.event_register_member(uuid, uuid, text) from public, anon;
revoke all on function public.event_registration_info(uuid) from public, anon;
revoke all on function public.event_registrants(uuid) from public, anon;
revoke all on function public.event_attendance_set(uuid, uuid, text, text) from public, anon;
revoke all on function public.event_attendance_walkin(uuid, uuid, text) from public, anon;
revoke all on function public.event_attendance_confirm(uuid) from public, anon;
grant execute on function public.event_registration_configure(uuid, timestamptz, timestamptz, integer, timestamptz) to authenticated;
grant execute on function public.event_register(uuid) to authenticated;
grant execute on function public.event_withdraw(uuid) to authenticated;
grant execute on function public.event_withdrawal_decide(uuid, uuid, boolean, text) to authenticated;
grant execute on function public.event_register_member(uuid, uuid, text) to authenticated;
grant execute on function public.event_registration_info(uuid) to authenticated;
grant execute on function public.event_registrants(uuid) to authenticated;
grant execute on function public.event_attendance_set(uuid, uuid, text, text) to authenticated;
grant execute on function public.event_attendance_walkin(uuid, uuid, text) to authenticated;
grant execute on function public.event_attendance_confirm(uuid) to authenticated;
