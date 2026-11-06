-- MVA-224: event coordinates and past-event backfill.
--
--   * event_details gains nullable latitude, longitude (validated; both or neither) and
--     hide_from_public_map (default false, for the public map ticket MVA-226). Coordinates live ONLY
--     in event_details: readable with read_event_details, no anon grant, so the anon-visible
--     `events` column set (id, title, event_type, starts_at, ends_at, status) is unchanged.
--   * save_event() gets a second form that accepts coordinates, the hide flag and a status. The
--     original eight-argument form is LEFT IN PLACE and untouched (it never reads or writes the new
--     columns), so older callers keep working and an edit through it keeps existing coordinates.
--     The new form is SECURITY INVOKER like the old one: every statement is checked by the
--     event_details / events policies, so only write_events holders change anything.
--   * Backfill: write_events holders can create an event in the past with status completed
--     (pre-app missions). A completed event must have started already. Existing validation is not
--     touched; no RSVP or readiness applies to a completed event without registration.
--   * Promotion from an opportunity (MVA-230) now copies the opportunity's coordinates to the event
--     (opportunity_promote redefined, copied from 20261106130000_event_registration.sql).
--
-- Additive only: three nullable/defaulted columns, one new function overload, one redefined
-- function, column grants for the new columns.

alter table public.event_details
  add column latitude numeric(9, 6),
  add column longitude numeric(9, 6),
  add column hide_from_public_map boolean not null default false,
  add constraint event_details_latitude_range check (latitude is null or latitude between -90 and 90),
  add constraint event_details_longitude_range check (longitude is null or longitude between -180 and 180),
  add constraint event_details_coords_pair check ((latitude is null) = (longitude is null));

-- Same shape as the existing detail columns: the write_events policies decide who may write.
grant insert (latitude, longitude, hide_from_public_map) on public.event_details to authenticated;
grant update (latitude, longitude, hide_from_public_map) on public.event_details to authenticated;

------------------------------------------------------------------------------
-- save_event with coordinates, hide flag and status (new overload; the old one stays)
------------------------------------------------------------------------------

create function public.save_event(
  p_id uuid,
  p_title text,
  p_event_type text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_location_name text,
  p_location_detail text,
  p_description text,
  p_latitude numeric,
  p_longitude numeric,
  p_hide_from_public_map boolean,
  p_status text
)
returns uuid
language plpgsql set search_path = ''
as $$
declare
  v_id uuid;
begin
  if (p_latitude is null) <> (p_longitude is null)
     or p_latitude < -90 or p_latitude > 90
     or p_longitude < -180 or p_longitude > 180 then
    raise exception 'invalid_coordinates' using errcode = 'P0001';
  end if;
  if p_status is not null and p_status not in ('scheduled', 'completed') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;
  if p_status = 'completed' and p_starts_at > now() then
    raise exception 'completed_in_future' using errcode = 'P0001';
  end if;

  if p_id is null then
    insert into public.events (title, event_type, starts_at, ends_at, status)
    values (p_title, p_event_type, p_starts_at, p_ends_at, coalesce(p_status, 'scheduled'))
    returning id into v_id;
  else
    update public.events
    set title = p_title, event_type = p_event_type, starts_at = p_starts_at, ends_at = p_ends_at,
        status = case
                   when p_status is null then status
                   when status = 'cancelled' then status   -- reinstating is its own action
                   else p_status
                 end
    where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;

  insert into public.event_details (event_id, location_name, location_detail, description, latitude, longitude, hide_from_public_map)
  values (
    v_id,
    nullif(btrim(coalesce(p_location_name, '')), ''),
    nullif(btrim(coalesce(p_location_detail, '')), ''),
    nullif(btrim(coalesce(p_description, '')), ''),
    p_latitude,
    p_longitude,
    coalesce(p_hide_from_public_map, false)
  )
  on conflict (event_id) do update set
    location_name = excluded.location_name,
    location_detail = excluded.location_detail,
    description = excluded.description,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    hide_from_public_map = excluded.hide_from_public_map;

  return v_id;
end;
$$;

revoke all on function public.save_event(uuid, text, text, timestamptz, timestamptz, text, text, text, numeric, numeric, boolean, text) from public, anon;
grant execute on function public.save_event(uuid, text, text, timestamptz, timestamptz, text, text, text, numeric, numeric, boolean, text) to authenticated;

------------------------------------------------------------------------------
-- Promotion copies the opportunity's coordinates. Copied from
-- 20261106130000_event_registration.sql (newest definition); only the save_event call changes.
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
    nullif(left(v_desc, 5000), ''),
    o.latitude,
    o.longitude,
    false,
    null
  );

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
