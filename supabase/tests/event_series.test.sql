-- Tier 1 database tests for MVA-228: recurring event series, restricted audiences, duplicate support.
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
  v_adm uuid := '00000000-0000-0000-0000-0000000000a1';
  v_cmd uuid := '00000000-0000-0000-0000-0000000000c1';
  v_og  uuid := '00000000-0000-0000-0000-0000000000b1';
  v_mem uuid := '00000000-0000-0000-0000-0000000000d1';
  v_rec uuid := '00000000-0000-0000-0000-0000000000e1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  sid uuid; sid2 uuid; sid3 uuid; sid4 uuid;
  a uuid; ev_cmd uuid; ev_pub uuid; ag uuid;
  n integer;
  total integer;
  s text;
  r record;
  d date;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  insert into public.invites (code, tier_id)
  select 'serfake00000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 14) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm, 'adm@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"serfake0000000010"}'),
    (v_cmd, 'cmd@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"serfake0000000011"}'),
    (v_og,  'og@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"serfake0000000012"}'),
    (v_mem, 'mem@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"serfake0000000013"}'),
    (v_rec, 'rec@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"serfake0000000014"}');
  update public.profiles set status = 'approved', tier_id = t_mem, is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Og' where id = v_og;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_recruit, setup_complete = true, callsign = 'Fake-Rec' where id = v_rec;

  ------------------------------------------------------------------ who may create
  perform pg_temp.act(v_mem);
  perform pg_temp.fails($q$select public.event_series_create('Fake', 'Meeting', 'command', current_date + 1, '19:00', 60, 'America/Phoenix', 'weekly', 1, null, null, null, null, null)$q$, 'not allowed');
  reset role;
  perform pg_temp.act(v_og);
  perform pg_temp.fails($q$select public.event_series_create('Fake', 'Meeting', 'command', current_date + 1, '19:00', 60, 'America/Phoenix', 'weekly', 1, null, null, null, null, null)$q$, 'not allowed');
  reset role;

  perform pg_temp.act(v_cmd);
  perform pg_temp.fails($q$select public.event_series_create('', 'Meeting', 'command', current_date + 1, '19:00', 60, 'America/Phoenix', 'weekly', 1, null, null, null, null, null)$q$, 'invalid_title');
  perform pg_temp.fails($q$select public.event_series_create('Fake', 'Meeting', 'public', current_date + 1, '19:00', 60, 'America/Phoenix', 'weekly', 1, null, null, null, null, null)$q$, 'invalid_audience');
  perform pg_temp.fails($q$select public.event_series_create('Fake', 'Meeting', 'command', current_date + 1, '19:00', 5, 'America/Phoenix', 'weekly', 1, null, null, null, null, null)$q$, 'invalid_duration');
  perform pg_temp.fails($q$select public.event_series_create('Fake', 'Meeting', 'command', current_date + 1, '19:00', 60, 'Mars/Olympus', 'weekly', 1, null, null, null, null, null)$q$, 'invalid_timezone');
  perform pg_temp.fails($q$select public.event_series_create('Fake', 'Meeting', 'command', current_date + 1, '19:00', 60, 'America/Phoenix', 'yearly', 1, null, null, null, null, null)$q$, 'invalid_rule');
  perform pg_temp.fails($q$select public.event_series_create('Fake', 'Meeting', 'command', current_date + 1, '19:00', 60, 'America/Phoenix', 'weekly', 0, null, null, null, null, null)$q$, 'invalid_interval');
  perform pg_temp.fails($q$select public.event_series_create('Fake', 'Meeting', 'command', current_date + 1, '19:00', 60, 'America/Phoenix', 'monthly_weekday', null, 6, null, null, null, null)$q$, 'invalid_nth');
  perform pg_temp.fails($q$select public.event_series_create('Fake', 'Meeting', 'command', current_date + 1, '19:00', 60, 'America/Phoenix', 'weekly', 1, null, current_date - 5, null, null, null)$q$, 'invalid_end');
  sid := public.event_series_create('Fake Command Standing', 'Meeting', 'command', current_date + 1, '19:00', 60, 'America/Phoenix', 'weekly', 1, null, null, null, 'Fake Room', 'Fake agenda');
  reset role;

  ------------------------------------------------------------------ instances are real, idempotent events
  select count(*) into total from public.events where series_id = sid;
  if total < 12 or total > 14 then raise exception 'FAIL: weekly over 90 days is 12 to 14 instances (got %)', total; end if;
  select count(*) into n from public.events where series_id = sid and audience = 'command' and event_type = 'Meeting';
  if n <> total then raise exception 'FAIL: every instance carries the audience'; end if;
  select count(*) into n from public.event_details d join public.events e on e.id = d.event_id where e.series_id = sid and d.location_name = 'Fake Room';
  if n <> total then raise exception 'FAIL: location carried to every instance (got %)', n; end if;
  perform pg_temp.act(v_cmd); perform public.event_series_roll(); perform public.event_series_roll(); reset role;
  select count(*) into n from public.events where series_id = sid;
  if n <> total then raise exception 'FAIL: rolling again must not duplicate (% vs %)', n, total; end if;
  if public.event_series_generate(sid, (now() at time zone 'America/Phoenix')::date) <> 0 then raise exception 'FAIL: generate is idempotent'; end if;
  begin
    insert into public.events (title, event_type, starts_at, series_id, series_date)
    select 'Fake dup', 'Meeting', now() + interval '1 year', series_id, series_date from public.events where series_id = sid limit 1;
    raise exception 'FAIL: duplicate (series, date) accepted';
  exception when unique_violation then null; end;

  ------------------------------------------------------------------ audience: Command-only stays Command-only
  perform pg_temp.act(v_cmd);
  select count(*) into n from public.events where series_id = sid;
  if n <> total then raise exception 'FAIL: Command sees the instances (got %)', n; end if;
  select count(*) into n from public.event_details d where d.location_name = 'Fake Room';
  if n <> total then raise exception 'FAIL: Command reads the details (got %)', n; end if;
  reset role;
  perform pg_temp.act(v_adm);
  select count(*) into n from public.events where series_id = sid;
  if n <> total then raise exception 'FAIL: Admin sees the instances (got %)', n; end if;
  reset role;
  perform pg_temp.act(v_og);
  select count(*) into n from public.events where title = 'Fake Command Standing';
  if n <> 0 then raise exception 'FAIL: Old Guard must not see a Command-only series (got %)', n; end if;
  select count(*) into n from public.event_details where location_name = 'Fake Room';
  if n <> 0 then raise exception 'FAIL: Old Guard must not read its details (got %)', n; end if;
  select count(*) into n from public.event_series where title = 'Fake Command Standing';
  if n <> 0 then raise exception 'FAIL: Old Guard must not see the series row (got %)', n; end if;
  reset role;
  perform pg_temp.act(v_mem);
  select count(*) into n from public.events where title = 'Fake Command Standing';
  if n <> 0 then raise exception 'FAIL: Member must not see a Command-only series (got %)', n; end if;
  reset role;
  perform pg_temp.act(v_rec);
  select count(*) into n from public.events where title = 'Fake Command Standing';
  if n <> 0 then raise exception 'FAIL: Recruit must not see a Command-only series (got %)', n; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  select count(*) into n from public.events where title = 'Fake Command Standing';
  if n <> 0 then raise exception 'FAIL: anon must not see a Command-only series (got %)', n; end if;
  perform pg_temp.fails('select count(*) from public.event_series');
  reset role;

  ------------------------------------------------------------------ nothing was announced; reminders go to the audience only
  select count(*) into n from public.notifications where title = 'Fake Command Standing' and kind = 'new';
  if n <> 0 then raise exception 'FAIL: instances must not announce themselves (got %)', n; end if;
  select starts_at into r from public.events where series_id = sid order by starts_at limit 1;
  perform public.generate_reminders(r.starts_at - interval '1440 minutes' + interval '1 minute');
  select count(*) into n from public.notifications where title = 'Fake Command Standing' and kind = 'reminder' and profile_id = v_cmd;
  if n <> 1 then raise exception 'FAIL: Command gets the reminder (got %)', n; end if;
  select count(*) into n from public.notifications where title = 'Fake Command Standing' and kind = 'reminder' and profile_id in (v_og, v_mem, v_rec);
  if n <> 0 then raise exception 'FAIL: lower tiers must not get a Command-only reminder (got %)', n; end if;

  ------------------------------------------------------------------ individually edited instances are protected
  select id into a from public.events where series_id = sid order by starts_at limit 1;
  perform pg_temp.act(v_cmd);
  perform public.save_event(a, 'Fake One-off Rename', 'Meeting', (select starts_at from public.events where id = a), (select ends_at from public.events where id = a), null, null, null);
  reset role;
  select series_edited into s from public.events where id = a;
  if s <> 'true' then raise exception 'FAIL: an edited instance is marked'; end if;
  select count(*) into n from public.event_series where id = sid and title = 'Fake Command Standing';
  if n <> 1 then raise exception 'FAIL: editing one instance leaves the series alone'; end if;

  perform pg_temp.act(v_cmd);
  n := public.event_series_update(sid, 'Fake Command Standing v2', 'Meeting', 'command', '20:00', 90, 'America/Phoenix', null, null, 'Fake Room', 'Fake agenda', null);
  reset role;
  if n <> total - 1 then raise exception 'FAIL: series edit touches every future un-edited instance (% vs %)', n, total - 1; end if;
  select title into s from public.events where id = a;
  if s <> 'Fake One-off Rename' then raise exception 'FAIL: the edited instance was overwritten'; end if;
  select count(*) into n from public.events where series_id = sid and title = 'Fake Command Standing v2'
     and (starts_at at time zone 'America/Phoenix')::time = '20:00' and ends_at - starts_at = interval '90 minutes';
  if n <> total - 1 then raise exception 'FAIL: new time and length applied (got %)', n; end if;
  select count(*) into n from public.notifications where kind = 'changed' and title = 'Fake Command Standing v2';
  -- (a moved meeting may notify its audience; it must never reach lower tiers)
  select count(*) into n from public.notifications where kind in ('changed', 'cancelled', 'new') and title like 'Fake Command Standing%' and profile_id in (v_og, v_mem, v_rec);
  if n <> 0 then raise exception 'FAIL: lower tiers must not be notified about a Command-only series (got %)', n; end if;

  -- "This and future": only from the given date.
  select series_date into d from public.events where series_id = sid and not series_edited order by starts_at offset 4 limit 1;
  perform pg_temp.act(v_cmd);
  n := public.event_series_update(sid, 'Fake Command Standing v3', 'Meeting', 'command', '20:00', 90, 'America/Phoenix', null, null, 'Fake Room', 'Fake agenda', d);
  reset role;
  select count(*) into n from public.events where series_id = sid and title = 'Fake Command Standing v3' and series_date >= d;
  select count(*) into total from public.events where series_id = sid and not series_edited and series_date >= d;
  if n <> total or n = 0 then raise exception 'FAIL: from-date edit covers the later instances (% of %)', n, total; end if;
  select count(*) into n from public.events where series_id = sid and title = 'Fake Command Standing v3' and series_date < d;
  if n <> 0 then raise exception 'FAIL: earlier instances keep the old title'; end if;

  perform pg_temp.act(v_mem);
  perform pg_temp.fails($q$select public.event_series_update('00000000-0000-0000-0000-000000000000', 'x', 'Meeting', 'command', '20:00', 90, 'America/Phoenix', null, null, null, null, null)$q$, 'not allowed');
  perform pg_temp.fails($q$select public.event_series_cancel('00000000-0000-0000-0000-000000000000')$q$, 'not allowed');
  reset role;

  ------------------------------------------------------------------ cancel the series
  insert into public.events (title, event_type, starts_at, series_id, series_date)
  values ('Fake Past Instance', 'Meeting', now() - interval '10 days', sid, current_date - 10);
  perform pg_temp.act(v_cmd); n := public.event_series_cancel(sid); reset role;
  select count(*) into n from public.events where series_id = sid and starts_at > now() and status = 'scheduled';
  if n <> 0 then raise exception 'FAIL: no future instance stays scheduled (got %)', n; end if;
  select status into s from public.events where id = a;
  if s <> 'cancelled' then raise exception 'FAIL: the edited instance is cancelled too'; end if;
  select status into s from public.events where title = 'Fake Past Instance';
  if s <> 'scheduled' then raise exception 'FAIL: past instances are untouched (got %)', s; end if;
  select status into s from public.event_series where id = sid;
  if s <> 'cancelled' then raise exception 'FAIL: series status'; end if;
  perform pg_temp.act(v_cmd); perform public.event_series_roll(); reset role;
  select count(*) into n from public.events where series_id = sid and starts_at > now() and status = 'scheduled';
  if n <> 0 then raise exception 'FAIL: a cancelled series generates nothing'; end if;
  select count(*) into n from public.notifications where kind = 'cancelled' and title like 'Fake Command Standing%';
  if n <> 0 then raise exception 'FAIL: cancelling a series is not one notice per meeting (got %)', n; end if;

  ------------------------------------------------------------------ daylight saving: 19:00 stays 19:00
  insert into public.event_series (title, event_type, audience, first_date, start_time, duration_minutes, timezone, rule, interval_weeks)
  values ('Fake DST Series', 'Meeting', 'members', date '2026-02-20', time '19:00', 60, 'America/New_York', 'weekly', 1) returning id into sid2;
  n := public.event_series_generate(sid2, date '2026-02-20');
  if n <> 13 then raise exception 'FAIL: 13 weekly instances in the window (got %)', n; end if;
  select count(*) into n from public.events where series_id = sid2 and (starts_at at time zone 'America/New_York')::time = '19:00';
  if n <> 13 then raise exception 'FAIL: every instance is 19:00 local (got %)', n; end if;
  select count(distinct (starts_at at time zone 'UTC')::time) into n from public.events where series_id = sid2;
  if n <> 2 then raise exception 'FAIL: the UTC time shifts across the change (got % distinct)', n; end if;

  ------------------------------------------------------------------ monthly by weekday, count and end date
  if public.nth_weekday(2026, 11, 2, 2) <> date '2026-11-10' then raise exception 'FAIL: 2nd Tuesday of Nov 2026'; end if;
  if public.nth_weekday(2026, 11, 5, 5) <> date '2026-11-27' then raise exception 'FAIL: last Friday of Nov 2026'; end if;
  if public.nth_weekday(2028, 2, 2, 5) <> date '2028-02-29' then raise exception 'FAIL: last Tuesday of Feb 2028'; end if;
  insert into public.event_series (title, event_type, audience, first_date, start_time, duration_minutes, timezone, rule, nth)
  values ('Fake Monthly', 'Meeting', 'members', date '2026-11-10', time '19:00', 60, 'America/Phoenix', 'monthly_weekday', 2) returning id into sid3;
  n := public.event_series_generate(sid3, date '2026-11-06');
  if n <> 3 then raise exception 'FAIL: three 2nd Tuesdays in the window (got %)', n; end if;
  select count(*) into n from public.events where series_id = sid3 and series_date in (date '2026-11-10', date '2026-12-08', date '2027-01-12');
  if n <> 3 then raise exception 'FAIL: the 2nd Tuesdays (got %)', n; end if;
  insert into public.event_series (title, event_type, audience, first_date, start_time, duration_minutes, timezone, rule, interval_weeks, max_count)
  values ('Fake Counted', 'Meeting', 'members', date '2026-11-03', time '19:00', 60, 'America/Phoenix', 'weekly', 1, 3) returning id into sid4;
  n := public.event_series_generate(sid4, date '2026-11-06');
  if n <> 2 then raise exception 'FAIL: count of 3 from the first date leaves 2 from today (got %)', n; end if;

  ------------------------------------------------------------------ "all members" series: Members yes, Recruits and anon no
  perform pg_temp.act(v_mem);
  select count(*) into n from public.events where series_id = sid3;
  if n <> 3 then raise exception 'FAIL: a Member sees an all-members series (got %)', n; end if;
  reset role;
  perform pg_temp.act(v_rec);
  select count(*) into n from public.events where title = 'Fake Monthly';
  if n <> 0 then raise exception 'FAIL: a Recruit must not see an all-members series (got %)', n; end if;
  reset role;

  ------------------------------------------------------------------ one event restricted by hand (what Duplicate uses)
  insert into public.events (title, event_type, starts_at) values ('Fake Plain Meeting', 'Meeting', now() + interval '9 days') returning id into ev_pub;
  insert into public.events (title, event_type, starts_at) values ('Fake Secret Meeting', 'Meeting', now() + interval '9 days') returning id into ev_cmd;
  perform pg_temp.act(v_mem);
  perform pg_temp.fails(format('select public.event_set_audience(%L, ''command'')', ev_cmd), 'not allowed');
  reset role;
  perform pg_temp.act(v_cmd);
  perform pg_temp.fails(format('select public.event_set_audience(%L, ''everyone'')', ev_cmd), 'invalid_audience');
  perform public.event_set_audience(ev_cmd, 'command');
  reset role;
  perform pg_temp.act(v_mem);
  select count(*) into n from public.events where id = ev_cmd;
  if n <> 0 then raise exception 'FAIL: a restricted event is invisible to a Member'; end if;
  select count(*) into n from public.events where id = ev_pub;
  if n <> 1 then raise exception 'FAIL: a public event stays visible'; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  select count(*) into n from public.events where id = ev_pub;
  if n <> 1 then raise exception 'FAIL: anon still sees public events'; end if;
  reset role;

  -- Its agenda is invisible below it; a public meeting's published agenda still shows.
  insert into public.agendas (event_id, status, publish_count, published_at) values (ev_cmd, 'published', 1, now()) returning id into ag;
  insert into public.agendas (event_id, status, publish_count, published_at) values (ev_pub, 'published', 1, now());
  perform pg_temp.act(v_mem);
  select count(*) into n from public.agendas where event_id in (ev_cmd, ev_pub);
  if n <> 1 then raise exception 'FAIL: a Member sees only the public meeting''s agenda (got %)', n; end if;
  reset role;
  perform pg_temp.act(v_cmd);
  select count(*) into n from public.agendas where event_id in (ev_cmd, ev_pub);
  if n <> 2 then raise exception 'FAIL: Command sees both agendas (got %)', n; end if;
  reset role;

  -- Registration on a restricted event is not reachable from below it.
  perform pg_temp.act(v_cmd); perform public.event_registration_configure(ev_cmd, null, null, null, null); reset role;
  perform pg_temp.act(v_mem);
  perform pg_temp.fails(format('select public.event_register(%L)', ev_cmd), 'not allowed');
  perform pg_temp.fails(format('select * from public.event_registration_info(%L)', ev_cmd), 'not allowed');
  perform pg_temp.fails(format('select * from public.event_registrants(%L)', ev_cmd), 'not allowed');
  reset role;

  raise notice 'event_series: ALL PASS';
end $$;

rollback;
