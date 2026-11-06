-- MVA-230: event opportunities and member bids. Outside events are listed as opportunities;
-- members say In / Maybe / Out; Command promotes the chosen ones into real team events. Interest
-- is ADVISORY: it informs Command and never commits the team or registers anyone.
--
-- Shape
--   * opportunities: title, host, optional source URL, an approximate date range (dates, not
--     times), location text, optional coordinates (plain columns for now; MVA-224 decides where
--     event coordinates live and promotion copies them once that exists), estimated cost per
--     person in cents, notes, status (open, promoted, dropped, expired).
--   * opportunity_responses: one row per (opportunity, member), In / Maybe / Out. Kept after a
--     promotion or a drop, as the record.
--   * Capabilities (new, none existed): read_opportunities (see the list and answer interest),
--     write_opportunities (create, and edit your own while Open), manage_opportunities (edit or
--     drop any, promote). Member, Old Guard and Command hold read and write; Command holds manage;
--     Admin passes every capability. "Contractors and Prospects only if Command enables it" is the
--     existing tier-capability screen: Admin switches read_opportunities on for that tier. Default off.
--   * Who answered: Old Guard, Command and Admin see names; everyone else sees counts and their own
--     answer. Enforced in RLS and in opportunity_responders(), not only in the screen.
--   * All writes are SECURITY DEFINER RPCs; no direct grants. Anon has no access at all.
--   * Promotion calls the existing save_event() (20261011210000_event_details.sql) so the event gets
--     the same validation and audit as any event. It needs write_events as well as
--     manage_opportunities. The opportunity holds dates only, so the event starts at 00:00 Phoenix on
--     the first day and ends 23:59 Phoenix on the last; Command sets real times by editing the event.
--   * Expiry: an Open opportunity whose end date (or start date when it has no end) is past, in
--     Phoenix time, becomes Expired. This runs at the start of every list, respond, edit, drop and
--     promote call (opportunity_expire), so no scheduler is needed and nothing shows stale.
--
-- Additive: two new tables, three capabilities, one widened check on notifications ('opportunity'
-- added; the list is copied from 20261103160000_meeting_agendas.sql, the newest definition).

------------------------------------------------------------------------------
-- Notifications: one new kind
------------------------------------------------------------------------------

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in ('reminder', 'new', 'cancelled', 'changed', 'test', 'motion', 'agenda', 'opportunity'));

------------------------------------------------------------------------------
-- Capabilities
------------------------------------------------------------------------------

insert into public.capabilities (key, description) values
  ('read_opportunities',   'See event opportunities and answer interest'),
  ('write_opportunities',  'Add event opportunities and edit your own while open'),
  ('manage_opportunities', 'Edit or drop any opportunity and promote one to an event');

insert into public.tier_capabilities (tier_id, capability_key)
select t.id, c.key
from public.tiers t
cross join (values ('read_opportunities'), ('write_opportunities')) as c (key)
where t.name in ('Member', 'Old Guard', 'Command');

insert into public.tier_capabilities (tier_id, capability_key)
select t.id, 'manage_opportunities' from public.tiers t where t.name = 'Command';

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 120),
  host text check (host is null or length(host) <= 120),
  source_url text check (source_url is null or (length(source_url) <= 500 and source_url ~* '^https?://[^[:space:]]+$')),
  starts_on date not null,
  ends_on date,
  location_text text check (location_text is null or length(location_text) <= 200),
  latitude numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude is null or longitude between -180 and 180),
  est_cost_cents bigint check (est_cost_cents is null or est_cost_cents between 0 and 100000000),
  notes text check (notes is null or length(notes) <= 2000),
  status text not null default 'open' check (status in ('open', 'promoted', 'dropped', 'expired')),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  event_id uuid references public.events (id) on delete set null,
  drop_reason text check (drop_reason is null or length(drop_reason) <= 500),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunities_dates check (ends_on is null or ends_on >= starts_on),
  constraint opportunities_coords_pair check ((latitude is null) = (longitude is null))
);

create index opportunities_starts_idx on public.opportunities (starts_on);

create table public.opportunity_responses (
  opportunity_id uuid not null references public.opportunities (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  response text not null check (response in ('In', 'Maybe', 'Out')),
  updated_at timestamptz not null default now(),
  primary key (opportunity_id, profile_id)
);

create index opportunity_responses_profile_idx on public.opportunity_responses (profile_id);

------------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------------

-- Phoenix has no daylight saving: UTC-7, exact (same assumption as phoenix_stamp).
create function public.phoenix_today()
returns date
language sql stable set search_path = ''
as $$
  select ((now() at time zone 'UTC') - interval '7 hours')::date
$$;

-- Old Guard, Command or Admin (approved): the people who may see who answered.
create function public.opportunity_can_see_names()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    left join public.tiers t on t.id = p.tier_id
    where p.id = auth.uid() and p.status = 'approved'
      and (p.is_admin or t.seat_group in ('old_guard', 'command'))
  )
$$;

create function public.opportunity_expire()
returns void
language sql security definer set search_path = ''
as $$
  update public.opportunities
     set status = 'expired', updated_at = now()
   where status = 'open' and coalesce(ends_on, starts_on) < public.phoenix_today()
$$;

create function public.opportunities_touch()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger opportunities_touch
  before insert or update on public.opportunities
  for each row execute function public.opportunities_touch();

revoke all on function public.phoenix_today() from public, anon;
revoke all on function public.opportunity_can_see_names() from public, anon;
revoke all on function public.opportunity_expire() from public, anon, authenticated;
revoke all on function public.opportunities_touch() from public, anon, authenticated;
grant execute on function public.phoenix_today() to authenticated;
grant execute on function public.opportunity_can_see_names() to authenticated;

------------------------------------------------------------------------------
-- RLS: readers see opportunities; responses are your own, or everyone's for Old Guard and up.
-- No direct write grants: every change goes through the RPCs below.
------------------------------------------------------------------------------

alter table public.opportunities enable row level security;
alter table public.opportunity_responses enable row level security;

revoke all on public.opportunities from anon, authenticated;
revoke all on public.opportunity_responses from anon, authenticated;
grant select on public.opportunities to authenticated;
grant select on public.opportunity_responses to authenticated;

create policy opportunities_select on public.opportunities
  for select to authenticated using (public.has_capability('read_opportunities'));

create policy opportunity_responses_select on public.opportunity_responses
  for select to authenticated
  using (
    public.has_capability('read_opportunities')
    and (profile_id = auth.uid() or public.opportunity_can_see_names())
  );

------------------------------------------------------------------------------
-- Notify helper
------------------------------------------------------------------------------

create function public.opportunity_notify(p_opportunity uuid, p_title text, p_body text, p_responses text[])
returns void
language sql security definer set search_path = ''
as $$
  insert into public.notifications (profile_id, kind, title, body, link)
  select r.profile_id, 'opportunity', left(p_title, 200), left(p_body, 300), '/opportunities'
  from public.opportunity_responses r
  join public.profiles p on p.id = r.profile_id and p.status = 'approved'
  where r.opportunity_id = p_opportunity and r.response = any (p_responses)
$$;

revoke all on function public.opportunity_notify(uuid, text, text, text[]) from public, anon, authenticated;

------------------------------------------------------------------------------
-- List: one row per opportunity with counts and the caller's own answer
------------------------------------------------------------------------------

create function public.opportunity_list()
returns table (
  id uuid, title text, host text, source_url text, starts_on date, ends_on date,
  location_text text, latitude numeric, longitude numeric, est_cost_cents bigint, notes text,
  status text, created_by uuid, creator_callsign text, event_id uuid, drop_reason text,
  in_count integer, maybe_count integer, out_count integer, my_response text
)
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_capability('read_opportunities') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.opportunity_expire();
  return query
    select o.id, o.title, o.host, o.source_url, o.starts_on, o.ends_on, o.location_text,
           o.latitude, o.longitude, o.est_cost_cents, o.notes, o.status, o.created_by,
           (select p.callsign from public.profiles p where p.id = o.created_by),
           o.event_id, o.drop_reason,
           (select count(*)::integer from public.opportunity_responses r where r.opportunity_id = o.id and r.response = 'In'),
           (select count(*)::integer from public.opportunity_responses r where r.opportunity_id = o.id and r.response = 'Maybe'),
           (select count(*)::integer from public.opportunity_responses r where r.opportunity_id = o.id and r.response = 'Out'),
           (select r.response from public.opportunity_responses r where r.opportunity_id = o.id and r.profile_id = auth.uid())
    from public.opportunities o
    order by o.starts_on, o.created_at;
end;
$$;

-- Names behind the counts: Old Guard, Command and Admin only.
create function public.opportunity_responders(p_opportunity uuid)
returns table (profile_id uuid, callsign text, response text)
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_capability('read_opportunities') or not public.opportunity_can_see_names() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select r.profile_id, p.callsign, r.response
    from public.opportunity_responses r
    join public.profiles p on p.id = r.profile_id
    where r.opportunity_id = p_opportunity
    order by r.response, p.callsign;
end;
$$;

------------------------------------------------------------------------------
-- Create / edit
------------------------------------------------------------------------------

create function public.opportunity_save(
  p_id uuid,
  p_title text,
  p_host text,
  p_source_url text,
  p_starts_on date,
  p_ends_on date,
  p_location_text text,
  p_latitude numeric,
  p_longitude numeric,
  p_est_cost_cents bigint,
  p_notes text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  o public.opportunities;
begin
  perform public.opportunity_expire();
  if p_id is null then
    if not public.has_capability('write_opportunities') then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    insert into public.opportunities
      (title, host, source_url, starts_on, ends_on, location_text, latitude, longitude, est_cost_cents, notes)
    values (
      p_title, nullif(btrim(coalesce(p_host, '')), ''), nullif(btrim(coalesce(p_source_url, '')), ''),
      p_starts_on, p_ends_on, nullif(btrim(coalesce(p_location_text, '')), ''),
      p_latitude, p_longitude, p_est_cost_cents, nullif(btrim(coalesce(p_notes, '')), '')
    )
    returning id into v_id;
    return v_id;
  end if;

  select * into o from public.opportunities where id = p_id for update;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not (
    public.has_capability('manage_opportunities')
    or (public.has_capability('write_opportunities') and o.created_by = auth.uid())
  ) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if o.status <> 'open' then
    raise exception 'not_open' using errcode = 'P0001';
  end if;
  update public.opportunities set
    title = p_title,
    host = nullif(btrim(coalesce(p_host, '')), ''),
    source_url = nullif(btrim(coalesce(p_source_url, '')), ''),
    starts_on = p_starts_on,
    ends_on = p_ends_on,
    location_text = nullif(btrim(coalesce(p_location_text, '')), ''),
    latitude = p_latitude,
    longitude = p_longitude,
    est_cost_cents = p_est_cost_cents,
    notes = nullif(btrim(coalesce(p_notes, '')), '')
  where id = p_id;
  return p_id;
end;
$$;

------------------------------------------------------------------------------
-- Interest: In / Maybe / Out, changeable while Open
------------------------------------------------------------------------------

create function public.opportunity_respond(p_opportunity uuid, p_response text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  o public.opportunities;
begin
  if not public.has_capability('read_opportunities') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_response is null or p_response not in ('In', 'Maybe', 'Out') then
    raise exception 'invalid_response' using errcode = 'P0001';
  end if;
  perform public.opportunity_expire();
  select * into o from public.opportunities where id = p_opportunity for update;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if o.status <> 'open' then
    raise exception 'not_open' using errcode = 'P0001';
  end if;
  insert into public.opportunity_responses (opportunity_id, profile_id, response)
  values (p_opportunity, auth.uid(), p_response)
  on conflict (opportunity_id, profile_id) do update set response = excluded.response, updated_at = now();
end;
$$;

------------------------------------------------------------------------------
-- Command: drop and promote
------------------------------------------------------------------------------

create function public.opportunity_drop(p_opportunity uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  o public.opportunities;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.has_capability('manage_opportunities') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;
  perform public.opportunity_expire();
  select * into o from public.opportunities where id = p_opportunity for update;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if o.status <> 'open' then
    raise exception 'not_open' using errcode = 'P0001';
  end if;
  update public.opportunities
     set status = 'dropped', drop_reason = v_reason, decided_by = auth.uid(), decided_at = now()
   where id = p_opportunity;
  -- Everyone who answered hears about it (interest is kept for the record).
  perform public.opportunity_notify(p_opportunity, 'Opportunity dropped: ' || o.title, v_reason,
                                    array['In', 'Maybe', 'Out']);
  insert into public.settings_audit (actor_id, event, target, detail)
  values (auth.uid(), 'opportunity_dropped', o.title, null);
end;
$$;

-- One action: creates the team event through save_event(), links it, marks the opportunity
-- Promoted and tells the members who answered In or Maybe that registration is open.
-- Nobody is registered automatically.
create function public.opportunity_promote(p_opportunity uuid, p_event_type text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  o public.opportunities;
  v_event uuid;
  v_desc text;
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

  v_event := public.save_event(
    null,
    o.title,
    p_event_type,
    (o.starts_on::timestamp + interval '7 hours') at time zone 'UTC',
    case when o.ends_on is not null
         then (o.ends_on::timestamp + interval '23 hours 59 minutes' + interval '7 hours') at time zone 'UTC' end,
    o.location_text,
    null,
    nullif(left(v_desc, 5000), '')
  );

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
-- Grants: authenticated only; each function checks its own capability
------------------------------------------------------------------------------

revoke all on function public.opportunity_list() from public, anon;
revoke all on function public.opportunity_responders(uuid) from public, anon;
revoke all on function public.opportunity_save(uuid, text, text, text, date, date, text, numeric, numeric, bigint, text) from public, anon;
revoke all on function public.opportunity_respond(uuid, text) from public, anon;
revoke all on function public.opportunity_drop(uuid, text) from public, anon;
revoke all on function public.opportunity_promote(uuid, text) from public, anon;
grant execute on function public.opportunity_list() to authenticated;
grant execute on function public.opportunity_responders(uuid) to authenticated;
grant execute on function public.opportunity_save(uuid, text, text, text, date, date, text, numeric, numeric, bigint, text) to authenticated;
grant execute on function public.opportunity_respond(uuid, text) to authenticated;
grant execute on function public.opportunity_drop(uuid, text) to authenticated;
grant execute on function public.opportunity_promote(uuid, text) to authenticated;
