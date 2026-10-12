-- Tier 1 database tests for MVA-142: traffic, RSVPs, readiness counts, tier breakdown.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_cmd uuid := '00000000-0000-0000-0000-0000000000c1';
  v_mem uuid := '00000000-0000-0000-0000-0000000000b1';
  v_mem2 uuid := '00000000-0000-0000-0000-0000000000b2';
  v_rec uuid := '00000000-0000-0000-0000-0000000000f1';
  v_pend uuid := '00000000-0000-0000-0000-0000000000d1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  e_future uuid; e_past uuid; e_cancelled uuid; tr1 uuid;
  n integer;
  r record;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  insert into public.invites (code, tier_id)
  select 'hqfake00000000' || g, t_recruit from generate_series(10, 14) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_cmd,  'cmd@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"hqfake0000000010"}'),
    (v_mem,  'mem@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"hqfake0000000011"}'),
    (v_mem2, 'mem2@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"hqfake0000000012"}'),
    (v_rec,  'rec@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"hqfake0000000013"}'),
    (v_pend, 'pend@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"hqfake0000000014"}');
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem2' where id = v_mem2;
  update public.profiles set status = 'approved', setup_complete = true, callsign = 'Fake-Rec' where id = v_rec;

  insert into public.events (title, starts_at) values ('Fake future', now() + interval '2 days') returning id into e_future;
  insert into public.events (title, starts_at) values ('Fake past', now() - interval '2 days') returning id into e_past;
  insert into public.events (title, starts_at, status) values ('Fake cancelled', now() + interval '3 days', 'cancelled') returning id into e_cancelled;

  ------------------------------------------------------------------ seed
  select count(*) into n from public.tier_capabilities where capability_key = 'write_traffic';
  if n <> 1 then raise exception 'FAIL: only Command should post traffic'; end if;
  select count(*) into n from public.tiers where counts_for_readiness and name in ('Command', 'Old Guard', 'Member');
  if n <> 3 then raise exception 'FAIL: readiness tiers wrong'; end if;
  select count(*) into n from public.tiers where counts_for_readiness and name in ('Contractor', 'Prospect', 'Recruit');
  if n <> 0 then raise exception 'FAIL: Contractor, Prospect and Recruit must not count for readiness'; end if;

  ------------------------------------------------------------------ traffic
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.traffic (title, body, pinned) values ('Fake notice', 'Fake body text', true) returning id into tr1;
  insert into public.traffic (title, body) values ('Fake second', 'More fake text');
  begin insert into public.traffic (title, body) values (repeat('t', 81), 'x'); raise exception 'FAIL: 81-char title';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.traffic (title, body) values ('x', repeat('b', 1001)); raise exception 'FAIL: 1001-char body';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.traffic (title, body) values ('x', '   '); raise exception 'FAIL: blank body';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin delete from public.traffic where id = tr1; raise exception 'FAIL: traffic deletable';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  update public.traffic set body = 'Fake body text v2' where id = tr1;
  update public.traffic set archived_at = now() where title = 'Fake second';

  select count(*) into n from public.settings_audit where event in ('traffic_posted', 'traffic_edited', 'traffic_archived');
  if n <> 4 then raise exception 'FAIL: traffic audit rows (got %)', n; end if;
  select count(*) into n from public.settings_audit where detail ~* 'body text';
  if n <> 0 then raise exception 'FAIL: audit leaked traffic body'; end if;

  -- Writers still see the archive.
  select count(*) into n from public.traffic; if n <> 2 then raise exception 'FAIL: writer should see archived traffic too'; end if;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.traffic; if n <> 1 then raise exception 'FAIL: member should see live traffic only (got %)', n; end if;
  begin insert into public.traffic (title, body) values ('Fake member post', 'x'); raise exception 'FAIL: member posted traffic';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  update public.traffic set archived_at = now() where id = tr1;
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: member archived traffic'; end if;

  ------------------------------------------------------------------ RSVP rules
  perform public.event_readiness(e_future);  -- members may call it
  insert into public.event_rsvps (event_id, response) values (e_future, 'in');
  insert into public.event_rsvps (event_id, response) values (e_future, 'in')
    on conflict (event_id, profile_id) do update set response = excluded.response;
  update public.event_rsvps set response = 'out' where event_id = e_future;
  update public.event_rsvps set response = 'tbd' where event_id = e_future;
  select count(*) into n from public.event_rsvps where event_id = e_future and profile_id = v_mem and response = 'tbd';
  if n <> 1 then raise exception 'FAIL: own rsvp not recorded'; end if;

  begin insert into public.event_rsvps (event_id, response) values (e_future, 'maybe'); raise exception 'FAIL: unknown response';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.event_rsvps (event_id, response) values (e_past, 'in'); raise exception 'FAIL: rsvp for a past event';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.event_rsvps (event_id, response) values (e_cancelled, 'in'); raise exception 'FAIL: rsvp for a cancelled event';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.event_rsvps (event_id, profile_id, response) values (e_future, v_mem2, 'in'); raise exception 'FAIL: rsvp for another member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- After the event starts the answer is frozen (the event is moved into the past by a trusted caller).
  reset role;
  perform set_config('request.jwt.claims', '', true);
  update public.events set starts_at = now() - interval '1 minute' where id = e_future;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.event_rsvps set response = 'in' where event_id = e_future;
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: rsvp changed after the event started'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  update public.events set starts_at = now() + interval '2 days' where id = e_future;

  ------------------------------------------------------------------ cannot touch someone else's row
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.event_rsvps (event_id, response) values (e_future, 'in');
  update public.event_rsvps set response = 'out' where profile_id = v_mem;
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: changed another member''s rsvp'; end if;
  select count(*) into n from public.event_rsvps where event_id = e_future; if n <> 2 then raise exception 'FAIL: members with event access should see rsvps'; end if;

  ------------------------------------------------------------------ readiness math: counts only
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.event_rsvps (event_id, response) values (e_future, 'out');
  -- eligible: Command + 2 Members = 3 (Recruit and the pending account do not count)
  select * into r from public.event_readiness(e_future);
  if r.eligible <> 3 or r.in_count <> 1 or r.out_count <> 1 or r.tbd_count <> 1 or r.no_response <> 0 then
    raise exception 'FAIL: readiness wrong (% % % % %)', r.eligible, r.in_count, r.out_count, r.tbd_count, r.no_response;
  end if;
  select * into r from public.event_readiness(e_cancelled);
  if r.eligible <> 3 or r.no_response <> 3 then raise exception 'FAIL: readiness with no answers'; end if;

  -- A recruit's RSVP never counts (they cannot even write one without read_event_details).
  reset role;
  perform set_config('request.jwt.claims', '', true);
  insert into public.event_rsvps (event_id, profile_id, response) values (e_future, v_rec, 'in');
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into r from public.event_readiness(e_future);
  if r.in_count <> 1 then raise exception 'FAIL: a Recruit counted toward readiness'; end if;

  ------------------------------------------------------------------ tier breakdown: no names
  select count(*) into n from public.tier_breakdown() b where b.tier_name = 'Member' and b.member_count = 2;
  if n <> 1 then raise exception 'FAIL: Member count'; end if;
  select count(*) into n from public.tier_breakdown() b where b.tier_name = 'Command' and b.member_count = 1;
  if n <> 1 then raise exception 'FAIL: Command count'; end if;
  select count(*) into n from public.tier_breakdown(); if n <> 6 then raise exception 'FAIL: all tiers should be listed (got %)', n; end if;
  select count(*) into n from public.tier_breakdown() b where b.tier_name = 'Prospect' and b.member_count = 0;
  if n <> 1 then raise exception 'FAIL: empty tiers should list zero'; end if;

  ------------------------------------------------------------------ Recruit, pending and anon
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rec, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.traffic; if n <> 1 then raise exception 'FAIL: an approved Recruit should read live traffic'; end if;
  select count(*) into n from public.event_rsvps; if n <> 0 then raise exception 'FAIL: recruit read rsvps'; end if;
  begin perform public.event_readiness(e_future); raise exception 'FAIL: recruit called event_readiness';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  perform * from public.tier_breakdown();
  begin insert into public.event_rsvps (event_id, response) values (e_future, 'in'); raise exception 'FAIL: recruit rsvp''d';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pend, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.traffic; if n <> 0 then raise exception 'FAIL: pending read traffic'; end if;
  begin perform public.tier_breakdown(); raise exception 'FAIL: pending called tier_breakdown';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform 1 from public.traffic; raise exception 'FAIL: anon read traffic';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform 1 from public.event_rsvps; raise exception 'FAIL: anon read rsvps';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.tier_breakdown(); raise exception 'FAIL: anon called tier_breakdown';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.event_readiness(e_future); raise exception 'FAIL: anon called event_readiness';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  raise notice 'hq_panels: ALL PASS';
end;
$$;

rollback;
