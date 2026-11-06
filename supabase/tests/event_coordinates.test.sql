-- Tier 1 database tests for MVA-224: event coordinates and past-event backfill.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

create function pg_temp.act(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

create function pg_temp.fails(q text, expected text default null) returns void language plpgsql as $$
begin
  begin
    execute q;
  exception when others then
    if expected is not null and sqlerrm <> expected then
      raise exception 'FAIL: "%" raised "%" not "%"', q, sqlerrm, expected;
    end if;
    return;
  end;
  raise exception 'FAIL: expected an error from %', q;
end $$;

do $$
declare
  v_cmd uuid := '00000000-0000-0000-0000-0000000000c1';
  v_mem uuid := '00000000-0000-0000-0000-0000000000d1';
  v_rec uuid := '00000000-0000-0000-0000-0000000000e1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  ev uuid; past uuid; fut uuid; opp uuid; promoted uuid;
  n integer;
  s text;
  r record;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  insert into public.invites (code, tier_id)
  select 'crdfake00000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 12) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_cmd, 'cmd@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"crdfake0000000010"}'),
    (v_mem, 'mem@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"crdfake0000000011"}'),
    (v_rec, 'rec@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"crdfake0000000012"}');
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_recruit, setup_complete = true, callsign = 'Fake-Rec' where id = v_rec;

  ------------------------------------------------------------------ Command saves a pin
  perform pg_temp.act(v_cmd);
  ev := public.save_event(null, 'Fake Pinned Event', 'Op', now() + interval '10 days', null, 'Fake Field', null, null, 33.4484, -112.074, true, null);
  reset role;
  select * into r from public.event_details where event_id = ev;
  if r.latitude <> 33.4484 or r.longitude <> -112.074 or not r.hide_from_public_map then raise exception 'FAIL: pin not stored'; end if;
  select status into s from public.events where id = ev;
  if s <> 'scheduled' then raise exception 'FAIL: default status (got %)', s; end if;

  ------------------------------------------------------------------ validation
  perform pg_temp.act(v_cmd);
  perform pg_temp.fails(format('select public.save_event(null, ''Fake'', ''Op'', now(), null, null, null, null, 33.4, null, false, null)'), 'invalid_coordinates');
  perform pg_temp.fails(format('select public.save_event(null, ''Fake'', ''Op'', now(), null, null, null, null, null, -112, false, null)'), 'invalid_coordinates');
  perform pg_temp.fails(format('select public.save_event(null, ''Fake'', ''Op'', now(), null, null, null, null, 95, 10, false, null)'), 'invalid_coordinates');
  perform pg_temp.fails(format('select public.save_event(null, ''Fake'', ''Op'', now(), null, null, null, null, 10, 181, false, null)'), 'invalid_coordinates');
  perform pg_temp.fails(format('select public.save_event(null, ''Fake'', ''Op'', now(), null, null, null, null, null, null, false, ''bogus'')'), 'invalid_status');
  perform pg_temp.fails(format('select public.save_event(null, ''Fake'', ''Op'', now() + interval ''2 days'', null, null, null, null, null, null, false, ''completed'')'), 'completed_in_future');
  reset role;

  ------------------------------------------------------------------ who may write
  perform pg_temp.act(v_mem);
  perform pg_temp.fails(format('select public.save_event(null, ''Fake'', ''Op'', now() + interval ''1 day'', null, null, null, null, 33.4, -112, false, null)'));
  perform pg_temp.fails(format('select public.save_event(%L, ''Fake hijack'', ''Op'', now() + interval ''1 day'', null, null, null, null, 1, 1, false, null)', ev), 'not allowed');
  reset role;
  select latitude into r from public.event_details where event_id = ev;
  if r.latitude <> 33.4484 then raise exception 'FAIL: a Member changed the pin'; end if;

  ------------------------------------------------------------------ who may read the pin
  perform pg_temp.act(v_mem);
  select count(*) into n from public.event_details where event_id = ev and latitude is not null;
  if n <> 1 then raise exception 'FAIL: a Member reads the pin (got %)', n; end if;
  reset role;
  perform pg_temp.act(v_rec);
  select count(*) into n from public.event_details where event_id = ev;
  if n <> 0 then raise exception 'FAIL: a Recruit reads event details (got %)', n; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  perform pg_temp.fails('select latitude from public.event_details');
  perform pg_temp.fails('select * from public.event_details');
  perform pg_temp.fails('select created_by from public.events');
  select count(*) into n from (select id, title, event_type, starts_at, ends_at, status from public.events where id = ev) x;
  if n <> 1 then raise exception 'FAIL: anon still sees the public columns (got %)', n; end if;
  reset role;

  ------------------------------------------------------------------ the old eight-argument form leaves the pin alone
  perform pg_temp.act(v_cmd);
  perform public.save_event(ev, 'Fake Pinned Event Renamed', 'Op', now() + interval '10 days', null, 'Fake Field 2', null, 'Fake notes');
  reset role;
  select * into r from public.event_details where event_id = ev;
  if r.latitude <> 33.4484 or r.location_name <> 'Fake Field 2' then raise exception 'FAIL: old form should keep the pin and change the text'; end if;

  -- The new form with no pin removes it.
  perform pg_temp.act(v_cmd);
  perform public.save_event(ev, 'Fake Pinned Event Renamed', 'Op', now() + interval '10 days', null, 'Fake Field 2', null, 'Fake notes', null, null, false, null);
  reset role;
  select * into r from public.event_details where event_id = ev;
  if r.latitude is not null or r.longitude is not null or r.hide_from_public_map then raise exception 'FAIL: pin not removed'; end if;

  ------------------------------------------------------------------ backfill of a past mission
  perform pg_temp.act(v_cmd);
  past := public.save_event(null, 'Fake 2015 Mission', 'Op', now() - interval '3650 days', null, 'Fake Old Field', null, null, 55.7558, 37.6173, false, 'completed');
  reset role;
  select status into s from public.events where id = past;
  if s <> 'completed' then raise exception 'FAIL: backfilled event should be completed (got %)', s; end if;
  select count(*) into n from public.notifications where title = 'Fake 2015 Mission';
  if n <> 0 then raise exception 'FAIL: a backfilled event must not notify anyone'; end if;
  -- No RSVP can be added to it.
  perform pg_temp.act(v_mem);
  perform pg_temp.fails(format('insert into public.event_rsvps (event_id, response) values (%L, ''in'')', past));
  reset role;
  -- A cancelled event keeps its status when edited through the new form.
  perform pg_temp.act(v_cmd);
  fut := public.save_event(null, 'Fake Cancelled', 'Op', now() + interval '5 days', null, null, null, null, null, null, false, null);
  update public.events set status = 'cancelled' where id = fut;
  perform public.save_event(fut, 'Fake Cancelled', 'Op', now() + interval '5 days', null, null, null, null, null, null, false, 'scheduled');
  reset role;
  select status into s from public.events where id = fut;
  if s <> 'cancelled' then raise exception 'FAIL: cancelled stays cancelled (got %)', s; end if;

  ------------------------------------------------------------------ promotion copies the opportunity's pin
  perform pg_temp.act(v_cmd);
  opp := public.opportunity_save(null, 'Fake Pinned Opportunity', null, null, current_date + 30, null, 'Fake Park', 40.5, -105.25, null, null);
  promoted := public.opportunity_promote(opp, 'Op');
  reset role;
  select * into r from public.event_details where event_id = promoted;
  if r.latitude <> 40.5 or r.longitude <> -105.25 then raise exception 'FAIL: promotion should copy the pin'; end if;

  raise notice 'event_coordinates: ALL PASS';
end $$;

rollback;
