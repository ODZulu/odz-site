-- Tier 1 database tests for MVA-229: event prep cadence templates.
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
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  steps jsonb;
  tpl uuid; tpl2 uuid;
  ev uuid; ev_t uuid; ev_o uuid; ev_late uuid;
  m_edit uuid;
  st60 uuid;
  v_start timestamptz;
  n integer;
  s text;
  r record;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  insert into public.invites (code, tier_id)
  select 'cadfake00000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 13) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm, 'adm@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"cadfake0000000010"}'),
    (v_cmd, 'cmd@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"cadfake0000000011"}'),
    (v_og,  'og@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"cadfake0000000012"}'),
    (v_mem, 'mem@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"cadfake0000000013"}');
  update public.profiles set status = 'approved', tier_id = t_mem, is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Og' where id = v_og;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;

  steps := '[
    {"title":"Kick-off","offset_days":60,"local_time":"19:00","duration_minutes":60,"audience":"command","topics":"Topic A"},
    {"title":"Logistics","offset_days":14,"local_time":"19:00","duration_minutes":90,"audience":"command","topics":"Topic B"},
    {"title":"Briefing","offset_days":7,"local_time":"18:30","duration_minutes":60,"audience":"old_guard","topics":"Topic C"},
    {"title":"Final check","offset_days":2,"local_time":"20:00","duration_minutes":30,"audience":"members","topics":null}
  ]'::jsonb;

  ------------------------------------------------------------------ only Command and Admin touch templates
  perform pg_temp.act(v_mem);
  perform pg_temp.fails(format('select public.event_cadence_template_save(null, ''Fake'', null, false, null, %L::jsonb)', steps), 'not allowed');
  reset role;
  perform pg_temp.act(v_og);
  perform pg_temp.fails(format('select public.event_cadence_template_save(null, ''Fake'', null, false, null, %L::jsonb)', steps), 'not allowed');
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  perform pg_temp.fails('select count(*) from public.event_cadence_templates');
  perform pg_temp.fails(format('select public.event_cadence_template_save(null, ''Fake'', null, false, null, %L::jsonb)', steps));
  reset role;

  ------------------------------------------------------------------ validation
  perform pg_temp.act(v_cmd);
  perform pg_temp.fails(format('select public.event_cadence_template_save(null, '' '', null, false, null, %L::jsonb)', steps), 'invalid_name');
  perform pg_temp.fails(format('select public.event_cadence_template_save(null, ''Fake'', ''Party'', false, null, %L::jsonb)', steps), 'invalid_event_type');
  perform pg_temp.fails(format('select public.event_cadence_template_save(null, ''Fake'', null, true, null, %L::jsonb)', steps), 'auto_needs_type');
  perform pg_temp.fails(format('select public.event_cadence_template_save(null, ''Fake'', null, false, ''Mars/Base'', %L::jsonb)', steps), 'invalid_timezone');
  perform pg_temp.fails('select public.event_cadence_template_save(null, ''Fake'', null, false, null, ''[]''::jsonb)', 'invalid_steps');
  perform pg_temp.fails('select public.event_cadence_template_save(null, ''Fake'', null, false, null, ''[{"title":"x","offset_days":5,"local_time":"19:00","duration_minutes":60,"audience":"everyone"}]''::jsonb)', 'invalid_step');
  perform pg_temp.fails('select public.event_cadence_template_save(null, ''Fake'', null, false, null, ''[{"title":"x","offset_days":-5,"local_time":"19:00","duration_minutes":60,"audience":"command"}]''::jsonb)', 'invalid_step');
  perform pg_temp.fails('select public.event_cadence_template_save(null, ''Fake'', null, false, null, ''[{"title":"x","local_time":"19:00","duration_minutes":60,"audience":"command"}]''::jsonb)', 'invalid_step');
  perform pg_temp.fails('select public.event_cadence_template_save(null, ''Fake'', null, false, null, ''[{"title":"x","offset_days":5,"local_time":"nope","duration_minutes":60,"audience":"command"}]''::jsonb)', 'invalid_step');
  tpl := public.event_cadence_template_save(null, 'Fake Op prep', null, false, null, steps);
  reset role;
  select count(*) into n from public.event_cadence_steps where template_id = tpl;
  if n <> 4 then raise exception 'FAIL: four steps saved (got %)', n; end if;
  perform pg_temp.act(v_og);
  select count(*) into n from public.event_cadence_templates;
  if n <> 0 then raise exception 'FAIL: Old Guard must not read templates (got %)', n; end if;
  reset role;
  perform pg_temp.act(v_adm);
  select count(*) into n from public.event_cadence_steps;
  if n <> 4 then raise exception 'FAIL: Admin reads the steps (got %)', n; end if;
  reset role;

  ------------------------------------------------------------------ plan and apply
  v_start := date_trunc('day', now() at time zone 'UTC') + interval '30 days 16 hours';
  insert into public.events (title, event_type, starts_at, ends_at) values ('Fake Big Op', 'Op', v_start, v_start + interval '4 hours') returning id into ev;

  perform pg_temp.act(v_mem);
  perform pg_temp.fails(format('select * from public.event_cadence_plan(%L, %L)', ev, tpl), 'not allowed');
  perform pg_temp.fails(format('select * from public.event_cadence_apply(%L, %L)', ev, tpl), 'not allowed');
  reset role;

  perform pg_temp.act(v_cmd);
  select count(*) into n from public.event_cadence_plan(ev, tpl) where action = 'skip_past';
  if n <> 1 then raise exception 'FAIL: the 60 day step is already past (got %)', n; end if;
  select count(*) into n from public.event_cadence_plan(ev, tpl) where action = 'create';
  if n <> 3 then raise exception 'FAIL: three steps would be created (got %)', n; end if;
  select count(*) into n from public.events where source_event_id = ev;
  if n <> 0 then raise exception 'FAIL: a preview must not create anything'; end if;
  select count(*) into n from public.event_cadence_apply(ev, tpl) where action = 'create';
  if n <> 3 then raise exception 'FAIL: apply creates three (got %)', n; end if;
  reset role;

  select count(*) into n from public.events where source_event_id = ev and event_type = 'Meeting';
  if n <> 3 then raise exception 'FAIL: three Meeting events linked to the source (got %)', n; end if;
  select count(*) into n from public.events m
   where m.source_event_id = ev and m.title = 'Fake Big Op: Logistics' and m.audience = 'command'
     and (m.starts_at at time zone 'America/Phoenix')::date = ((v_start at time zone 'America/Phoenix')::date - 14)
     and (m.starts_at at time zone 'America/Phoenix')::time = '19:00'
     and m.ends_at - m.starts_at = interval '90 minutes';
  if n <> 1 then raise exception 'FAIL: Logistics meeting has the right date, time, length and audience'; end if;
  select count(*) into n from public.event_details d join public.events m on m.id = d.event_id
   where m.source_event_id = ev and d.description in ('Topic B', 'Topic C');
  if n <> 2 then raise exception 'FAIL: topics become the description (got %)', n; end if;
  select count(*) into n from public.events where source_event_id = ev and cadence_step_id is not null;
  if n <> 3 then raise exception 'FAIL: each meeting links to its step'; end if;

  -- Audience: Command sees them; Old Guard and Member see none of the Command-only ones.
  perform pg_temp.act(v_cmd);
  select count(*) into n from public.events where source_event_id = ev;
  if n <> 3 then raise exception 'FAIL: Command sees all three (got %)', n; end if;
  reset role;
  perform pg_temp.act(v_og);
  select count(*) into n from public.events where source_event_id = ev and audience = 'command';
  if n <> 0 then raise exception 'FAIL: Old Guard must not see Command-only prep (got %)', n; end if;
  select count(*) into n from public.events where source_event_id = ev;
  if n <> 2 then raise exception 'FAIL: Old Guard sees the Briefing and the all-members Final check (got %)', n; end if;
  reset role;
  perform pg_temp.act(v_mem);
  select count(*) into n from public.events where source_event_id = ev;
  if n <> 1 then raise exception 'FAIL: a Member sees only the all-members Final check (got %)', n; end if;
  select count(*) into n from public.events where source_event_id = ev and audience <> 'members';
  if n <> 0 then raise exception 'FAIL: a Member sees no restricted prep (got %)', n; end if;
  reset role;
  select count(*) into n from public.notifications where kind = 'new' and title in ('Fake Big Op: Logistics', 'Fake Big Op: Briefing') and profile_id in (v_mem);
  if n <> 0 then raise exception 'FAIL: a Member is not told of Command-only prep (got %)', n; end if;

  -- Idempotent.
  perform pg_temp.act(v_cmd);
  select count(*) into n from public.event_cadence_apply(ev, tpl) where action in ('create', 'update');
  if n <> 0 then raise exception 'FAIL: applying twice changes nothing (got %)', n; end if;
  reset role;
  select count(*) into n from public.events where source_event_id = ev;
  if n <> 3 then raise exception 'FAIL: no duplicates (got %)', n; end if;

  ------------------------------------------------------------------ editing a template leaves existing meetings alone; re-apply updates them
  select jsonb_agg(
           jsonb_build_object('id', s.id, 'title', s.title, 'offset_days', s.offset_days, 'local_time', s.local_time::text,
                              'duration_minutes', s.duration_minutes, 'audience', s.audience,
                              'topics', case when s.title = 'Logistics' then 'Topic B2' else s.topics end)
           order by s.position)
    into steps from public.event_cadence_steps s where s.template_id = tpl;
  perform pg_temp.act(v_cmd); perform public.event_cadence_template_save(tpl, 'Fake Op prep', null, false, null, steps); reset role;
  select count(*) into n from public.event_details d join public.events m on m.id = d.event_id where m.source_event_id = ev and d.description = 'Topic B';
  if n <> 1 then raise exception 'FAIL: saving a template must not alter existing meetings'; end if;
  select count(*) into n from public.event_cadence_steps where template_id = tpl;
  if n <> 4 then raise exception 'FAIL: steps are updated in place, not duplicated (got %)', n; end if;
  perform pg_temp.act(v_cmd);
  select count(*) into n from public.event_cadence_plan(ev, tpl) where action = 'update';
  if n <> 1 then raise exception 'FAIL: the preview shows the one change (got %)', n; end if;
  perform public.event_cadence_apply(ev, tpl);
  reset role;
  select count(*) into n from public.event_details d join public.events m on m.id = d.event_id where m.source_event_id = ev and d.description = 'Topic B2';
  if n <> 1 then raise exception 'FAIL: re-apply updates the unedited meeting'; end if;

  ------------------------------------------------------------------ a meeting edited by hand is protected
  select id into m_edit from public.events where source_event_id = ev and title = 'Fake Big Op: Briefing';
  perform pg_temp.act(v_cmd);
  perform public.save_event(m_edit, 'Fake Big Op: Briefing (moved)', 'Meeting', (select starts_at from public.events where id = m_edit) + interval '1 hour',
                            (select ends_at from public.events where id = m_edit) + interval '1 hour', null, null, 'Hand-written');
  reset role;
  select series_edited into s from public.events where id = m_edit;
  if s <> 'true' then raise exception 'FAIL: the hand edit is marked'; end if;
  perform pg_temp.act(v_cmd);
  select count(*) into n from public.event_cadence_plan(ev, tpl) where action = 'leave_edited';
  if n <> 1 then raise exception 'FAIL: the edited meeting is left alone in the plan (got %)', n; end if;
  perform public.event_cadence_apply(ev, tpl);
  reset role;
  select title into s from public.events where id = m_edit;
  if s <> 'Fake Big Op: Briefing (moved)' then raise exception 'FAIL: re-apply overwrote a hand edit'; end if;

  ------------------------------------------------------------------ the event moves: unedited meetings follow, edited ones are flagged
  select starts_at into r from public.events where source_event_id = ev and title = 'Fake Big Op: Logistics';
  perform pg_temp.act(v_cmd);
  perform public.save_event(ev, 'Fake Big Op', 'Op', v_start + interval '3 days', v_start + interval '3 days 4 hours', null, null, null);
  reset role;
  select count(*) into n from public.events where source_event_id = ev and title = 'Fake Big Op: Logistics'
     and starts_at = r.starts_at + interval '3 days';
  if n <> 1 then raise exception 'FAIL: the unedited meeting keeps its offset (moves 3 days)'; end if;
  select cadence_review, starts_at into r from public.events where id = m_edit;
  if not r.cadence_review then raise exception 'FAIL: the edited meeting is flagged for review'; end if;
  select count(*) into n from public.events where source_event_id = ev and cadence_review;
  if n <> 1 then raise exception 'FAIL: only the edited meeting is flagged (got %)', n; end if;
  perform pg_temp.act(v_cmd); perform public.event_cadence_review_done(m_edit); reset role;
  select cadence_review into s from public.events where id = m_edit;
  if s <> 'false' then raise exception 'FAIL: review flag cleared'; end if;
  perform pg_temp.act(v_mem);
  perform pg_temp.fails(format('select public.event_cadence_review_done(%L)', m_edit), 'not allowed');
  reset role;

  ------------------------------------------------------------------ cancelling the event cancels future prep, keeps past prep
  select id into st60 from public.event_cadence_steps where template_id = tpl and offset_days = 60;
  insert into public.events (title, event_type, starts_at, ends_at, audience, source_event_id, cadence_step_id)
  values ('Fake Big Op: Kick-off', 'Meeting', now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 'command', ev, st60);
  perform pg_temp.act(v_cmd);
  update public.events set status = 'cancelled' where id = ev;
  reset role;
  select count(*) into n from public.events where source_event_id = ev and starts_at > now() and status = 'scheduled';
  if n <> 0 then raise exception 'FAIL: no future prep stays scheduled (got %)', n; end if;
  select count(*) into n from public.events where source_event_id = ev and starts_at > now() and status = 'cancelled';
  if n <> 3 then raise exception 'FAIL: all three future meetings cancelled, edited one included (got %)', n; end if;
  select status into s from public.events where title = 'Fake Big Op: Kick-off';
  if s <> 'scheduled' then raise exception 'FAIL: past prep is untouched (got %)', s; end if;
  select count(*) into n from public.notifications where kind = 'cancelled' and title like 'Fake Big Op: %';
  if n <> 0 then raise exception 'FAIL: cancelling an event is not a notice per prep meeting (got %)', n; end if;
  perform pg_temp.act(v_cmd);
  perform pg_temp.fails(format('select * from public.event_cadence_apply(%L, %L)', ev, tpl), 'not_scheduled');
  reset role;

  ------------------------------------------------------------------ automatic apply by event type, and retiring
  perform pg_temp.act(v_cmd);
  tpl2 := public.event_cadence_template_save(null, 'Fake Training prep', 'Training', true, null,
          '[{"title":"Plan","offset_days":3,"local_time":"19:00","duration_minutes":45,"audience":"old_guard","topics":"Plan it"}]'::jsonb);
  ev_t := public.save_event(null, 'Fake Training Day', 'Training', v_start + interval '10 days', null, null, null, null);
  ev_o := public.save_event(null, 'Fake Other Op', 'Op', v_start + interval '10 days', null, null, null, null);
  reset role;
  select count(*) into n from public.events where source_event_id = ev_t and title = 'Fake Training Day: Plan';
  if n <> 1 then raise exception 'FAIL: a new Training event gets the cadence by itself (got %)', n; end if;
  select count(*) into n from public.events where source_event_id = ev_o;
  if n <> 0 then raise exception 'FAIL: other event types are not touched (got %)', n; end if;
  perform pg_temp.act(v_cmd); perform public.event_cadence_template_retire(tpl2, true); reset role;
  perform pg_temp.act(v_cmd);
  ev_late := public.save_event(null, 'Fake Later Training', 'Training', v_start + interval '12 days', null, null, null, null);
  perform pg_temp.fails(format('select * from public.event_cadence_apply(%L, %L)', ev_late, tpl2), 'template_retired');
  reset role;
  select count(*) into n from public.events where source_event_id = ev_late;
  if n <> 0 then raise exception 'FAIL: a retired template stops applying (got %)', n; end if;
  select count(*) into n from public.events where source_event_id = ev_t;
  if n <> 1 then raise exception 'FAIL: retiring leaves existing meetings alone (got %)', n; end if;

  raise notice 'event_cadence: ALL PASS';
end $$;

rollback;
