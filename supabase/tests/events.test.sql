-- Tier 1 database tests for MVA-201: events, the public view, who may read details and who may write.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_cmd  uuid := '00000000-0000-0000-0000-0000000000c1';
  v_mem  uuid := '00000000-0000-0000-0000-0000000000b1';
  v_rec  uuid := '00000000-0000-0000-0000-0000000000f1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  ev uuid;
  ev2 uuid;
  n integer;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  insert into public.invites (code, tier_id)
  select 'eventsfake0000000' || g, t_recruit from generate_series(1, 3) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_cmd, 'cmd@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"eventsfake00000001"}'),
    (v_mem, 'mem@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"eventsfake00000002"}'),
    (v_rec, 'rec@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"eventsfake00000003"}');
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', setup_complete = true, callsign = 'Fake-Rec' where id = v_rec;

  ------------------------------------------------------------------ seed: who reads details
  select count(*) into n from public.tier_capabilities tc join public.tiers t on t.id = tc.tier_id
    where tc.capability_key = 'read_event_details' and t.name in ('Recruit', 'Prospect', 'Contractor');
  if n <> 0 then raise exception 'FAIL: junior tiers should not read event details by default'; end if;
  select count(*) into n from public.tier_capabilities tc join public.tiers t on t.id = tc.tier_id
    where tc.capability_key = 'read_event_details' and t.name in ('Command', 'Old Guard', 'Member');
  if n <> 3 then raise exception 'FAIL: Member and above should read event details (got %)', n; end if;

  ------------------------------------------------------------------ Command writes
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.events (title, event_type, starts_at, ends_at)
  values ('  Fake Game Day  ', 'Game Day', now() + interval '3 days', now() + interval '3 days 4 hours')
  returning id into ev;
  insert into public.event_details (event_id, location_name, location_detail, description)
  values (ev, 'Fake Field', 'Fake directions: gate 2', '# Fake brief' || chr(10) || 'bring water');

  select count(*) into n from public.events where id = ev and title = 'Fake Game Day' and created_by = v_cmd and status = 'scheduled';
  if n <> 1 then raise exception 'FAIL: event not created as expected'; end if;

  -- Validation
  begin insert into public.events (title, starts_at, ends_at) values ('Fake bad', now(), now() - interval '1 hour');
    raise exception 'FAIL: end before start accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.events (title, starts_at) values ('   ', now());
    raise exception 'FAIL: blank title accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.events (title, event_type, starts_at) values ('Fake', 'Party', now());
    raise exception 'FAIL: unknown type accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin update public.events set created_by = v_mem where id = ev;
    raise exception 'FAIL: created_by editable';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin update public.events set external_id = 'x' where id = ev;
    raise exception 'FAIL: external_id editable by clients';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Edit, move, cancel, reinstate.
  update public.event_details set location_name = 'Fake Field B' where event_id = ev;
  update public.events set starts_at = now() + interval '4 days', ends_at = now() + interval '4 days 2 hours' where id = ev;
  update public.events set status = 'cancelled' where id = ev;
  update public.events set status = 'scheduled' where id = ev;
  update public.events set status = 'cancelled' where id = ev;

  select count(*) into n from public.settings_audit where target = 'Fake Game Day'
    and event in ('event_created', 'event_edited', 'event_cancelled', 'event_reinstated');
  if n <> 6 then raise exception 'FAIL: expected 6 audit rows for the event (got %)', n; end if;
  select count(*) into n from public.settings_audit where event = 'event_edited' and detail = 'start time changed';
  if n <> 1 then raise exception 'FAIL: start time change not noted'; end if;
  select count(*) into n from public.settings_audit where detail ~* 'brief|water|directions';
  if n <> 0 then raise exception 'FAIL: audit leaked event content'; end if;

  ------------------------------------------------------------------ Member reads, cannot write
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.event_details where location_detail is not null;
  if n <> 1 then raise exception 'FAIL: member should read event details'; end if;
  select count(*) into n from public.events where id = ev;
  if n <> 1 then raise exception 'FAIL: member should read the listing'; end if;
  begin insert into public.event_details (event_id, location_name) values (ev, 'Hacked');
    raise exception 'FAIL: member wrote event details';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  update public.event_details set location_name = 'Hacked' where event_id = ev;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: member edited event details'; end if;
  begin perform public.save_event(ev, 'Hacked', 'Other', now() + interval '1 day', null, null, null, null);
    raise exception 'FAIL: member saved an event through save_event';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.events (title, starts_at) values ('Fake member', now());
    raise exception 'FAIL: member created an event';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  update public.events set title = 'Hacked' where id = ev;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: member edited an event'; end if;
  delete from public.events where id = ev;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: member deleted an event'; end if;

  ------------------------------------------------------------------ Recruit reads the listing, never the details
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rec, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.events where title = 'Fake Game Day' and status = 'cancelled';
  if n <> 1 then raise exception 'FAIL: recruit should see the public listing, cancelled included'; end if;
  select count(*) into n from public.event_details;
  if n <> 0 then raise exception 'FAIL: recruit read event details'; end if;
  select count(*) into n from public.events e join public.event_details d on d.event_id = e.id;
  if n <> 0 then raise exception 'FAIL: recruit joined event details'; end if;
  begin insert into public.event_details (event_id, location_name) values (ev, 'x');
    raise exception 'FAIL: recruit wrote event details';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ anon: the listing columns only
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  select count(*) into n from public.events;
  if n <> 1 then raise exception 'FAIL: anon should see the public listing'; end if;
  select count(*) into n from (select id, title, event_type, starts_at, ends_at, status from public.events) x;
  if n <> 1 then raise exception 'FAIL: anon cannot read the listing columns'; end if;
  begin perform created_by from public.events; raise exception 'FAIL: anon read created_by';
  exception when insufficient_privilege then null; end;
  begin perform external_id from public.events; raise exception 'FAIL: anon read external_id';
  exception when insufficient_privilege then null; end;
  begin perform * from public.events; raise exception 'FAIL: anon select * on events';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.event_details; raise exception 'FAIL: anon read event_details';
  exception when insufficient_privilege then null; end;
  begin perform location_detail from public.events; raise exception 'FAIL: location_detail still on events';
  exception when undefined_column then null; end;
  begin perform 1 from public.public_events; raise exception 'FAIL: public_events view still exists';
  exception when undefined_table then null; end;
  begin insert into public.events (title, starts_at) values ('Fake anon', now()); raise exception 'FAIL: anon created an event';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.event_details (event_id, location_name) values (ev, 'x'); raise exception 'FAIL: anon wrote event details';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ save_event: both tables, one audit row
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ev2 := public.save_event(null, 'Fake Saved', 'Training', now() + interval '5 days', null, 'Fake Spot', ' ', 'fake body');
  select count(*) into n from public.event_details where event_id = ev2 and location_name = 'Fake Spot'
    and location_detail is null and description = 'fake body';
  if n <> 1 then raise exception 'FAIL: save_event did not store details (blank becomes null)'; end if;
  perform public.save_event(ev2, 'Fake Saved Two', 'Training', now() + interval '6 days', null, 'Fake Spot B', null, 'fake body 2');
  select count(*) into n from public.settings_audit where target = 'Fake Saved Two' and event = 'event_edited';
  if n <> 1 then raise exception 'FAIL: saving title and details together should log one edit (got %)', n; end if;
  select count(*) into n from public.settings_audit where detail ~* 'Fake Spot|fake body';
  if n <> 0 then raise exception 'FAIL: audit leaked event details'; end if;
  begin perform public.save_event(ev2, 'x', 'Training', now(), now() - interval '1 hour', null, null, null);
    raise exception 'FAIL: save_event accepted end before start';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- The function is not callable by anon.
  set local role anon;
  begin perform public.save_event(null, 'Fake anon', 'Other', now(), null, null, null, null);
    raise exception 'FAIL: anon called save_event';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- Delete exists for writers (cancel is the normal path).
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.events where id = ev;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: writer could not delete'; end if;
  reset role;

  raise notice 'events: ALL PASS';
end;
$$;

rollback;
