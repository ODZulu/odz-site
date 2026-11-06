-- Tier 1 database tests for MVA-231: event registration and Command attendance confirmation.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

create function pg_temp.act(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

-- Runs q and requires it to fail; if `expected` is given the error message must match exactly.
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
  v_adm uuid := '00000000-0000-0000-0000-0000000000a1';
  v_cmd uuid := '00000000-0000-0000-0000-0000000000c1';
  v_og  uuid := '00000000-0000-0000-0000-0000000000b1';
  m1 uuid := '00000000-0000-0000-0000-0000000000d1';
  m2 uuid := '00000000-0000-0000-0000-0000000000d2';
  m3 uuid := '00000000-0000-0000-0000-0000000000d3';
  m4 uuid := '00000000-0000-0000-0000-0000000000d4';
  m5 uuid := '00000000-0000-0000-0000-0000000000d5';
  v_rec uuid := '00000000-0000-0000-0000-0000000000e1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  ev0 uuid; ev1 uuid; ev2 uuid; ev3 uuid; ev4 uuid; ev5 uuid; opp uuid; promoted uuid;
  n integer;
  s text;
  r record;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  ------------------------------------------------------------------ seed
  insert into public.invites (code, tier_id)
  select 'regfake00000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 19) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm, 'adm@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"regfake0000000010"}'),
    (v_cmd, 'cmd@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"regfake0000000011"}'),
    (v_og,  'og@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"regfake0000000012"}'),
    (m1,    'm1@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"regfake0000000013"}'),
    (m2,    'm2@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"regfake0000000014"}'),
    (m3,    'm3@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"regfake0000000015"}'),
    (m4,    'm4@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"regfake0000000016"}'),
    (m5,    'm5@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"regfake0000000017"}'),
    (v_rec, 'rec@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"regfake0000000018"}');
  update public.profiles set status = 'approved', tier_id = t_mem, is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Og' where id = v_og;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M1' where id = m1;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M2' where id = m2;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M3' where id = m3;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M4' where id = m4;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M5' where id = m5;
  update public.profiles set status = 'approved', tier_id = t_recruit, setup_complete = true, callsign = 'Fake-Rec' where id = v_rec;

  insert into public.events (title, event_type, starts_at, ends_at) values ('Fake Plain Event', 'Other', now() + interval '10 days', null) returning id into ev0;
  insert into public.events (title, event_type, starts_at, ends_at) values ('Fake Capped Event', 'Op', now() + interval '20 days', now() + interval '20 days 4 hours') returning id into ev1;
  insert into public.events (title, event_type, starts_at, ends_at) values ('Fake Late Event', 'Op', now() + interval '3 days', now() + interval '3 days 4 hours') returning id into ev2;
  insert into public.events (title, event_type, starts_at, ends_at) values ('Fake Closed Event', 'Op', now() + interval '15 days', null) returning id into ev3;
  insert into public.events (title, event_type, starts_at, ends_at) values ('Fake Not Yet Event', 'Op', now() + interval '25 days', null) returning id into ev4;
  insert into public.events (title, event_type, starts_at, ends_at) values ('Fake Past Event', 'Op', now() - interval '3 days', now() - interval '3 days' + interval '2 hours') returning id into ev5;
  insert into public.event_details (event_id, location_name) values (ev5, 'Fake Field');

  ------------------------------------------------------------------ plain RSVP still works where registration is off
  perform pg_temp.act(m1);
  insert into public.event_rsvps (event_id, response) values (ev0, 'in');
  reset role;

  ------------------------------------------------------------------ who may configure
  perform pg_temp.act(m1);
  perform pg_temp.fails(format('select public.event_registration_configure(%L, null, null, 2, null)', ev1), 'not allowed');
  reset role;
  perform pg_temp.act(v_og);
  perform pg_temp.fails(format('select public.event_registration_configure(%L, null, null, 2, null)', ev1), 'not allowed');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  perform pg_temp.fails(format('select public.event_registration_configure(%L, null, null, 2, null)', ev1));
  perform pg_temp.fails('select count(*) from public.event_registrations');
  perform pg_temp.fails(format('select public.event_register(%L)', ev1));
  perform pg_temp.fails(format('select * from public.event_registration_info(%L)', ev1));
  reset role;

  perform pg_temp.act(v_cmd);
  perform pg_temp.fails(format('select public.event_registration_configure(%L, null, null, 0, null)', ev1), 'invalid_capacity');
  perform pg_temp.fails(format('select public.event_registration_configure(%L, now(), now() - interval ''1 day'', 2, null)', ev1), 'invalid_window');
  perform pg_temp.fails(format('select public.event_registration_configure(%L, null, null, 2, %L)', ev1, now() + interval '30 days'), 'invalid_cutoff');
  perform public.event_registration_configure(ev1, null, null, 2, null);
  reset role;
  select count(*) into n from public.event_registration_settings s join public.events e on e.id = s.event_id
   where s.event_id = ev1 and s.withdraw_cutoff_at = e.starts_at - interval '7 days';
  if n <> 1 then raise exception 'FAIL: default cutoff should be 7 days before the start'; end if;

  ------------------------------------------------------------------ RSVP is refused once registration is on
  perform pg_temp.act(m2);
  perform pg_temp.fails(format('insert into public.event_rsvps (event_id, response) values (%L, ''in'')', ev1));
  reset role;

  ------------------------------------------------------------------ register, capacity, waitlist
  perform pg_temp.act(v_rec);
  perform pg_temp.fails(format('select public.event_register(%L)', ev1), 'not allowed');
  reset role;
  perform pg_temp.act(m1); s := public.event_register(ev1); reset role;
  if s <> 'registered' then raise exception 'FAIL: m1 should be registered (got %)', s; end if;
  perform pg_temp.act(m2); s := public.event_register(ev1); reset role;
  if s <> 'registered' then raise exception 'FAIL: m2 should be registered (got %)', s; end if;
  perform pg_temp.act(m3); s := public.event_register(ev1); reset role;
  if s <> 'waitlisted' then raise exception 'FAIL: m3 should be waitlisted (got %)', s; end if;
  perform pg_temp.act(m4); s := public.event_register(ev1); reset role;
  if s <> 'waitlisted' then raise exception 'FAIL: m4 should be waitlisted (got %)', s; end if;
  perform pg_temp.act(m1);
  perform pg_temp.fails(format('select public.event_register(%L)', ev1), 'already_registered');
  select * into r from public.event_registration_info(ev1);
  if r.registered_count <> 2 or r.waitlist_count <> 2 or r.my_state <> 'registered' then raise exception 'FAIL: m1 info % % %', r.registered_count, r.waitlist_count, r.my_state; end if;
  if r.no_show_count is not null or r.unmarked_count is not null then raise exception 'FAIL: counts of marks are not for members'; end if;
  reset role;
  perform pg_temp.act(m4);
  select * into r from public.event_registration_info(ev1);
  if r.my_position <> 2 then raise exception 'FAIL: m4 is second on the waitlist (got %)', r.my_position; end if;
  reset role;

  ------------------------------------------------------------------ who sees the list
  perform pg_temp.act(m1);
  select count(*) into n from public.event_registrants(ev1);
  if n <> 4 then raise exception 'FAIL: a registrant sees the list (got %)', n; end if;
  select count(*) into n from public.event_registrants(ev1) where attendance is not null;
  if n <> 0 then raise exception 'FAIL: attendance is not for members'; end if;
  select count(*) into n from public.event_registrations;
  if n <> 1 then raise exception 'FAIL: the table shows a member only their own row (got %)', n; end if;
  reset role;
  perform pg_temp.act(m5);
  perform pg_temp.fails(format('select * from public.event_registrants(%L)', ev1), 'not allowed');
  select * into r from public.event_registration_info(ev1);
  if r.registered_count <> 2 or r.my_state is not null then raise exception 'FAIL: a non-registrant sees counts and no state'; end if;
  reset role;
  perform pg_temp.act(v_og);
  select count(*) into n from public.event_registrants(ev1);
  if n <> 4 then raise exception 'FAIL: Old Guard sees the list (got %)', n; end if;
  reset role;

  ------------------------------------------------------------------ withdrawal before the cutoff promotes the waitlist
  perform pg_temp.act(m1); s := public.event_withdraw(ev1); reset role;
  if s <> 'withdrawn' then raise exception 'FAIL: free withdrawal (got %)', s; end if;
  select state into s from public.event_registrations where event_id = ev1 and profile_id = m3;
  if s <> 'registered' then raise exception 'FAIL: m3 should be promoted (got %)', s; end if;
  select count(*) into n from public.notifications where profile_id = m3 and kind = 'registration' and title like 'You are in:%';
  if n <> 1 then raise exception 'FAIL: m3 should be told (got %)', n; end if;
  perform pg_temp.act(m4);
  select * into r from public.event_registration_info(ev1);
  if r.my_position <> 1 then raise exception 'FAIL: m4 moves up (got %)', r.my_position; end if;
  reset role;
  perform pg_temp.act(m1);
  perform pg_temp.fails(format('select public.event_withdraw(%L)', ev1), 'not_registered');
  s := public.event_register(ev1);                      -- back in, behind the waitlist
  reset role;
  if s <> 'waitlisted' then raise exception 'FAIL: re-registering into a full event waitlists (got %)', s; end if;

  -- A waitlisted member leaves freely too, and nobody is promoted because the places are full.
  perform pg_temp.act(m4); s := public.event_withdraw(ev1); reset role;
  if s <> 'withdrawn' then raise exception 'FAIL: waitlist withdrawal (got %)', s; end if;

  ------------------------------------------------------------------ raising capacity promotes the waitlist
  perform pg_temp.act(v_cmd); perform public.event_registration_configure(ev1, null, null, 3, null); reset role;
  select state into s from public.event_registrations where event_id = ev1 and profile_id = m1;
  if s <> 'registered' then raise exception 'FAIL: raised capacity promotes m1 (got %)', s; end if;

  ------------------------------------------------------------------ after the cutoff: request, decide
  perform pg_temp.act(v_cmd); perform public.event_registration_configure(ev2, null, null, null, null); reset role;
  perform pg_temp.act(m1); perform public.event_register(ev2); reset role;
  perform pg_temp.act(m2); perform public.event_register(ev2); reset role;
  perform pg_temp.act(m1); s := public.event_withdraw(ev2);
  if s <> 'withdrawal_requested' then raise exception 'FAIL: after the cutoff it is a request (got %)', s; end if;
  perform pg_temp.fails(format('select public.event_withdraw(%L)', ev2), 'already_requested');
  select * into r from public.event_registration_info(ev2);
  if r.registered_count <> 2 then raise exception 'FAIL: a pending request still holds its place (got %)', r.registered_count; end if;
  perform pg_temp.fails(format('select public.event_withdrawal_decide(%L, %L, true, null)', ev2, m1), 'not allowed');
  reset role;
  perform pg_temp.act(v_og);
  perform pg_temp.fails(format('select public.event_withdrawal_decide(%L, %L, true, null)', ev2, m1), 'not allowed');
  reset role;
  perform pg_temp.act(v_cmd);
  perform public.event_withdrawal_decide(ev2, m1, true, 'Fake: approved');
  perform pg_temp.fails(format('select public.event_withdrawal_decide(%L, %L, true, null)', ev2, m1), 'no_request');
  reset role;
  select state into s from public.event_registrations where event_id = ev2 and profile_id = m1;
  if s <> 'withdrawn' then raise exception 'FAIL: approved withdrawal (got %)', s; end if;
  perform pg_temp.act(m2); perform public.event_withdraw(ev2); reset role;
  perform pg_temp.act(v_cmd); perform public.event_withdrawal_decide(ev2, m2, false, 'Fake: declined'); reset role;
  select state into s from public.event_registrations where event_id = ev2 and profile_id = m2;
  if s <> 'registered' then raise exception 'FAIL: declined request keeps the registration (got %)', s; end if;
  select count(*) into n from public.event_registration_log where event_id = ev2 and action in ('withdrawal_requested', 'withdrawal_approved', 'withdrawal_declined');
  if n <> 4 then raise exception 'FAIL: withdrawal steps are logged (got %)', n; end if;
  select count(*) into n from public.notifications where profile_id = m1 and kind = 'registration' and title like 'Withdrawal approved:%';
  if n <> 1 then raise exception 'FAIL: m1 is told of the approval'; end if;

  ------------------------------------------------------------------ the window, and Command's override
  perform pg_temp.act(v_cmd);
  perform public.event_registration_configure(ev3, now() - interval '2 days', now() - interval '1 day', 1, null);
  perform public.event_registration_configure(ev4, now() + interval '2 days', null, null, null);
  reset role;
  perform pg_temp.act(m1);
  perform pg_temp.fails(format('select public.event_register(%L)', ev3), 'closed');
  perform pg_temp.fails(format('select public.event_register(%L)', ev4), 'not_open');
  perform pg_temp.fails(format('select public.event_register_member(%L, %L, ''Fake reason'')', ev3, m1), 'not allowed');
  reset role;
  perform pg_temp.act(v_cmd);
  perform pg_temp.fails(format('select public.event_register_member(%L, %L, ''x'')', ev3, m1), 'invalid_reason');
  perform public.event_register_member(ev3, m1, 'Fake: late but needed');
  perform public.event_register_member(ev3, m2, 'Fake: also needed');    -- over capacity 1: Command may
  perform pg_temp.fails(format('select public.event_register_member(%L, %L, ''Fake reason'')', ev3, m1), 'already_registered');
  reset role;
  select count(*) into n from public.event_registrations where event_id = ev3 and state = 'registered';
  if n <> 2 then raise exception 'FAIL: override registers past the window and capacity (got %)', n; end if;
  select count(*) into n from public.event_registration_log where event_id = ev3 and action = 'override_registered' and detail like 'Fake:%';
  if n <> 2 then raise exception 'FAIL: overrides are logged with the reason (got %)', n; end if;

  ------------------------------------------------------------------ attendance: needs the event to have ended
  perform pg_temp.act(v_cmd); perform public.event_registration_configure(ev5, null, null, null, null); reset role;
  update public.event_registration_settings set opens_at = now() - interval '10 days' where event_id = ev5;
  insert into public.event_registrations (event_id, profile_id, state) values
    (ev5, m1, 'registered'), (ev5, m2, 'registered'), (ev5, m3, 'registered');
  insert into public.event_registrations (event_id, profile_id, state, registered_at) values (ev5, m4, 'waitlisted', now() - interval '1 day');

  perform pg_temp.act(m1);
  perform pg_temp.fails(format('select public.event_attendance_set(%L, %L, ''attended'')', ev5, m1), 'not allowed');
  reset role;
  perform pg_temp.act(v_og);
  perform pg_temp.fails(format('select public.event_attendance_set(%L, %L, ''attended'')', ev5, m1), 'not allowed');
  reset role;
  perform pg_temp.act(v_cmd);
  perform pg_temp.fails(format('select public.event_attendance_set(%L, %L, ''attended'')', ev1, m3), 'not_ended');
  perform pg_temp.fails(format('select public.event_attendance_set(%L, %L, ''bogus'')', ev5, m1), 'invalid_result');
  perform pg_temp.fails(format('select public.event_attendance_set(%L, %L, ''attended'')', ev5, m4), 'not_a_registrant');

  perform public.event_attendance_set(ev5, m1, 'attended');
  reset role;
  select count(*) into n from public.service_history where profile_id = m1 and source = 'app' and title = 'Fake Past Event' and location = 'Fake Field';
  if n <> 1 then raise exception 'FAIL: Attended writes a service entry (got %)', n; end if;
  perform pg_temp.act(v_cmd); perform public.event_attendance_set(ev5, m1, 'no_show'); reset role;
  select count(*) into n from public.service_history where profile_id = m1 and title = 'Fake Past Event';
  if n <> 0 then raise exception 'FAIL: changing the mark removes the service entry (got %)', n; end if;
  perform pg_temp.act(v_cmd); perform public.event_attendance_set(ev5, m1, 'attended'); reset role;
  select count(*) into n from public.service_history where profile_id = m1 and title = 'Fake Past Event';
  if n <> 1 then raise exception 'FAIL: one entry after re-marking (got %)', n; end if;

  -- Confirm needs everyone marked.
  perform pg_temp.act(m1); perform pg_temp.fails(format('select public.event_attendance_confirm(%L)', ev5), 'not allowed'); reset role;
  perform pg_temp.act(v_cmd);
  perform pg_temp.fails(format('select public.event_attendance_confirm(%L)', ev5), 'unmarked');
  perform public.event_attendance_set(ev5, m2, 'no_show');
  perform public.event_attendance_set(ev5, m3, 'excused');
  select * into r from public.event_registration_info(ev5);
  if r.no_show_count <> 1 or r.excused_count <> 1 or r.attended_count <> 1 or r.unmarked_count <> 0 then raise exception 'FAIL: Command sees the mark counts'; end if;
  perform public.event_attendance_confirm(ev5);
  perform pg_temp.fails(format('select public.event_attendance_confirm(%L)', ev5), 'confirmed');
  reset role;
  select status into s from public.events where id = ev5;
  if s <> 'completed' then raise exception 'FAIL: confirming completes the event (got %)', s; end if;
  select count(*) into n from public.settings_audit where event = 'event_completed' and target = 'Fake Past Event';
  if n <> 1 then raise exception 'FAIL: completion is audited as event_completed'; end if;

  -- Locked: a correction needs a reason and is logged with before and after.
  perform pg_temp.act(v_cmd);
  perform pg_temp.fails(format('select public.event_attendance_set(%L, %L, ''attended'')', ev5, m2), 'reason_required');
  perform public.event_attendance_set(ev5, m2, 'attended', 'Fake: was marked in error');
  reset role;
  select count(*) into n from public.service_history where profile_id = m2 and title = 'Fake Past Event';
  if n <> 1 then raise exception 'FAIL: a correction to Attended writes the entry'; end if;
  select count(*) into n from public.event_registration_log
   where event_id = ev5 and profile_id = m2 and action = 'attendance_corrected' and detail like 'no_show -> attended:%';
  if n <> 1 then raise exception 'FAIL: the correction is logged with before and after'; end if;

  -- Walk-in.
  perform pg_temp.act(v_cmd);
  perform pg_temp.fails(format('select public.event_attendance_walkin(%L, %L, '''')', ev5, m5), 'invalid_reason');
  perform pg_temp.fails(format('select public.event_attendance_walkin(%L, %L, ''Fake walk-in'')', ev5, m1), 'already_registered');
  perform public.event_attendance_walkin(ev5, m5, 'Fake: turned up with a friend');
  reset role;
  select count(*) into n from public.event_registrations where event_id = ev5 and profile_id = m5 and walk_in and attendance = 'attended';
  if n <> 1 then raise exception 'FAIL: walk-in recorded'; end if;
  select count(*) into n from public.service_history where profile_id = m5 and title = 'Fake Past Event';
  if n <> 1 then raise exception 'FAIL: walk-in earns a service entry'; end if;
  select registered_count into n from (select * from public.event_registration_info(ev5)) x;
  if n <> 3 then raise exception 'FAIL: walk-ins do not count as registrants (got %)', n; end if;

  -- What a member sees of their own result, and of others'.
  perform pg_temp.act(m3);
  select * into r from public.event_registration_info(ev5);
  if r.my_attendance <> 'excused' then raise exception 'FAIL: m3 sees their own result after confirmation (got %)', r.my_attendance; end if;
  if r.no_show_count is not null then raise exception 'FAIL: no-show counts are not for members'; end if;
  reset role;
  perform pg_temp.act(v_og);
  select * into r from public.event_registration_info(ev5);
  if r.no_show_count is null then raise exception 'FAIL: Old Guard sees the mark counts'; end if;
  reset role;

  -- The log cannot be edited.
  perform pg_temp.fails('update public.event_registration_log set detail = ''edited''');

  ------------------------------------------------------------------ promotion from an opportunity starts registration
  perform pg_temp.act(m1);
  opp := public.opportunity_save(null, 'Fake Promoted Opp', null, null, current_date + 40, null, null, null, null, null, null);
  reset role;
  perform pg_temp.act(v_cmd); promoted := public.opportunity_promote(opp, 'Op'); reset role;
  select count(*) into n from public.event_registration_settings where event_id = promoted;
  if n <> 1 then raise exception 'FAIL: a promoted event starts with registration on'; end if;
  perform pg_temp.act(m2); s := public.event_register(promoted); reset role;
  if s <> 'registered' then raise exception 'FAIL: registering for a promoted event (got %)', s; end if;

  raise notice 'event_registration: ALL PASS';
end $$;

rollback;
