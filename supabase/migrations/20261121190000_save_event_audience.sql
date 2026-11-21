-- MVA-303: saving an event is all-or-nothing, audience included.
--
-- Before: the app called save_event() and then event_set_audience(). Between the two the event
-- existed without its audience, so a Command-only event was briefly public, and stayed public if
-- the second call failed. Now save_event() takes the audience and writes the event and its
-- audience in one statement of one transaction.
--
--   * p_audience: 'public' (everyone, stored as null), 'members', 'old_guard' or 'command'.
--     Creating an event with p_audience null is rejected (invalid_audience). Updating with null
--     keeps the existing audience. Nothing about who can see a saved event changes.
--   * The 12-argument save_event() (Block 5, dev only) is dropped: it could still create an event
--     with no audience, and nothing calls it after this change. Callers: the app (updated),
--     opportunity_promote (below) and the SQL tests (updated).
--   * The 8-argument save_event() is KEPT. It is the form the live prod app calls (created in
--     20261011210000_event_details.sql), so dropping it would break event create and edit on
--     prod from the moment this migration is applied until the release reaches main (D21,
--     additive only). It can still create an event with no audience (public), exactly as prod
--     does today; nothing new is exposed. MVA-304 drops it after the release is live.
--   * event_set_audience() is dropped: nothing calls it any more.
--   * authenticated gets column INSERT/UPDATE on events.audience so the invoker-security
--     save_event() can write it; the write_events policies still decide who may write.
--
-- Not purely additive: the 12-argument form is replaced by the 13-argument one and
-- event_set_audience() is removed (both exist only on dev). Lord reviews this diff. opportunity_promote is copied from 20261106140000_event_coordinates.sql
-- (newest definition); only its save_event() call changes.

grant insert (audience) on public.events to authenticated;
grant update (audience) on public.events to authenticated;

drop function public.save_event(uuid, text, text, timestamptz, timestamptz, text, text, text, numeric, numeric, boolean, text);
drop function public.event_set_audience(uuid, text);

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
  p_status text,
  p_audience text
)
returns uuid
language plpgsql set search_path = ''
as $$
declare
  v_id uuid;
  v_aud text;
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

  -- Audience is part of the same statement as the event, so there is no moment where the event
  -- exists without it. 'public' is the explicit way to say everyone; a new event must say one.
  if p_audience is not null and p_audience not in ('public', 'members', 'old_guard', 'command') then
    raise exception 'invalid_audience' using errcode = 'P0001';
  end if;
  if p_id is null and p_audience is null then
    raise exception 'invalid_audience' using errcode = 'P0001';
  end if;
  v_aud := case when p_audience = 'public' then null else p_audience end;

  if p_id is null then
    insert into public.events (title, event_type, starts_at, ends_at, status, audience)
    values (p_title, p_event_type, p_starts_at, p_ends_at, coalesce(p_status, 'scheduled'), v_aud)
    returning id into v_id;
  else
    update public.events
    set title = p_title, event_type = p_event_type, starts_at = p_starts_at, ends_at = p_ends_at,
        audience = case when p_audience is null then audience else v_aud end,   -- null keeps what it was
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

revoke all on function public.save_event(uuid, text, text, timestamptz, timestamptz, text, text, text, numeric, numeric, boolean, text, text) from public, anon;
grant execute on function public.save_event(uuid, text, text, timestamptz, timestamptz, text, text, text, numeric, numeric, boolean, text, text) to authenticated;

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
    null,
    'public'   -- a promoted opportunity has always been a public event
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

