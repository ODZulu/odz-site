-- Tier 1 database tests for MVA-246: live meeting votes.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_adm uuid := '00000000-0000-0000-0000-0000000000a1';
  c1 uuid := '00000000-0000-0000-0000-0000000000c1';
  c2 uuid := '00000000-0000-0000-0000-0000000000c2';
  o1 uuid := '00000000-0000-0000-0000-0000000000b1';
  o2 uuid := '00000000-0000-0000-0000-0000000000b2';
  o3 uuid := '00000000-0000-0000-0000-0000000000b3';
  v_mem uuid := '00000000-0000-0000-0000-0000000000d1';
  v_mem2 uuid := '00000000-0000-0000-0000-0000000000d2';
  v_rec uuid := '00000000-0000-0000-0000-0000000000d3';
  v_sup uuid := '00000000-0000-0000-0000-0000000000d4';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid; t_sup uuid;
  ev uuid; ag uuid; ag_draft uuid; ev_draft uuid;
  i_main uuid; i_tie uuid; i_quo uuid; i_few uuid; i_wd uuid; i_disc uuid; i_blank uuid; i_draft uuid;
  m1 uuid; m2 uuid; m3 uuid; m4 uuid; m5 uuid; m5b uuid;
  n integer;
  res text;
  r record;
  body text;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';
  select id into t_sup from public.tiers where name = 'Support';

  ------------------------------------------------------------------ seed
  insert into public.invites (code, tier_id)
  select 'lvfake000000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 19) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm,  'adm@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"lvfake00000000010"}'),
    (c1,     'c1@example.invalid',   'authenticated', 'authenticated', '{"invite_code":"lvfake00000000011"}'),
    (c2,     'c2@example.invalid',   'authenticated', 'authenticated', '{"invite_code":"lvfake00000000012"}'),
    (o1,     'o1@example.invalid',   'authenticated', 'authenticated', '{"invite_code":"lvfake00000000013"}'),
    (o2,     'o2@example.invalid',   'authenticated', 'authenticated', '{"invite_code":"lvfake00000000014"}'),
    (o3,     'o3@example.invalid',   'authenticated', 'authenticated', '{"invite_code":"lvfake00000000015"}'),
    (v_mem,  'mem@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"lvfake00000000016"}'),
    (v_mem2, 'mem2@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"lvfake00000000017"}'),
    (v_rec,  'rec@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"lvfake00000000018"}'),
    (v_sup,  'sup@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"lvfake00000000019"}');
  update public.profiles set status = 'approved', tier_id = t_mem, is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-C1' where id = c1;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-C2' where id = c2;
  update public.profiles set tier_id = t_cmd where id in (c1, c2);
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-O1' where id = o1;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-O2' where id = o2;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-O3' where id = o3;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem2' where id = v_mem2;
  update public.profiles set status = 'approved', tier_id = t_recruit, setup_complete = true, callsign = 'Fake-Rec' where id = v_rec;
  update public.profiles set status = 'approved', tier_id = t_sup, setup_complete = true, callsign = 'Fake-Sup' where id = v_sup;

  insert into public.events (title, event_type, starts_at, ends_at)
    values ('Fake live meeting', 'Meeting', now() + interval '2 days', now() + interval '2 days 2 hours') returning id into ev;
  insert into public.events (title, event_type, starts_at)
    values ('Fake draft meeting', 'Meeting', now() + interval '3 days') returning id into ev_draft;

  -- Build and publish the agenda as the chair (Command holds write_events).
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.agendas (event_id) values (ev) returning id into ag;
  insert into public.agenda_items (agenda_id, position, title, kind, vote_wording)
    values (ag, 1, 'Fake main vote', 'vote', 'Shall the fake bylaw be adopted as written?') returning id into i_main;
  insert into public.agenda_items (agenda_id, position, title, kind, vote_wording)
    values (ag, 2, 'Fake tie vote', 'vote', 'Shall the fake treasurer be appointed?') returning id into i_tie;
  insert into public.agenda_items (agenda_id, position, title, kind, vote_wording)
    values (ag, 3, 'Fake quorum vote', 'vote', 'Shall the fake meeting adjourn?') returning id into i_quo;
  insert into public.agenda_items (agenda_id, position, title, kind, vote_wording)
    values (ag, 4, 'Fake few voters vote', 'vote', 'Shall the fake seat be filled?') returning id into i_few;
  insert into public.agenda_items (agenda_id, position, title, kind, vote_wording)
    values (ag, 5, 'Fake withdrawn vote', 'vote', 'Shall the fake motion be withdrawn?') returning id into i_wd;
  insert into public.agenda_items (agenda_id, position, title, kind) values (ag, 6, 'Fake discussion', 'discuss') returning id into i_disc;
  insert into public.agenda_items (agenda_id, position, title, kind) values (ag, 7, 'Fake blank vote', 'vote') returning id into i_blank;
  insert into public.agendas (event_id) values (ev_draft) returning id into ag_draft;
  insert into public.agenda_items (agenda_id, position, title, kind, vote_wording)
    values (ag_draft, 1, 'Fake draft vote', 'vote', 'Fake wording') returning id into i_draft;
  reset role;

  ------------------------------------------------------------------ opening is the chair's, on a published vote item
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.open_live_vote(i_draft); raise exception 'FAIL: opened on an unpublished agenda';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'agenda_not_published' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.publish_agenda(ag);
  begin perform public.open_live_vote(i_disc); raise exception 'FAIL: opened on a discussion item';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_a_vote_item' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.open_live_vote(i_blank); raise exception 'FAIL: opened with no wording';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'no_wording' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  foreach body in array array['o1', 'mem', 'rec'] loop
    perform set_config('request.jwt.claims', json_build_object('sub',
      case body when 'o1' then o1 when 'mem' then v_mem else v_rec end, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin perform public.open_live_vote(i_main); raise exception 'FAIL: % opened a live vote', body;
    exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
    reset role;
  end loop;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform public.open_live_vote(i_main); raise exception 'FAIL: anon opened a live vote';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.live_vote_progress(gen_random_uuid()); raise exception 'FAIL: anon read progress';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ open the main vote
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  m1 := public.open_live_vote(i_main);
  begin perform public.open_live_vote(i_main); raise exception 'FAIL: opened twice';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'already_opened' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select * into r from public.motions where id = m1;
  if r.mode <> 'live' or r.state <> 'open' or r.status <> 'open' or r.body <> 'old_guard' or r.deadline is not null
     or r.parent_type <> 'agenda_item' or r.parent_id <> i_main or r.options <> '["Yes","No","Abstain"]'::jsonb
     or r.description <> 'Shall the fake bylaw be adopted as written?' or r.quorum_at_open is not null then
    raise exception 'FAIL: live motion not set up as specified';
  end if;
  -- Old Guard and Command vote; Member, Recruit and Support do not.
  select count(*) into n from public.motion_voters where motion_id = m1 and round = 1 and profile_id in (c1, c2, o1, o2, o3);
  if n <> 5 then raise exception 'FAIL: the 5 Old Guard and Command members are the voters (got %)', n; end if;
  select count(*) into n from public.motion_voters where motion_id = m1 and profile_id in (v_adm, v_mem, v_mem2, v_rec, v_sup);
  if n <> 0 then raise exception 'FAIL: a non-voting tier was snapshotted as a voter'; end if;
  -- Consulted: Member and above who are not voters; not Recruit, not Support.
  select count(*) into n from public.motion_consulted where motion_id = m1 and profile_id in (v_mem, v_mem2, v_adm);
  if n <> 3 then raise exception 'FAIL: Members are consulted (got %)', n; end if;
  select count(*) into n from public.motion_consulted where motion_id = m1 and profile_id in (v_rec, v_sup, c1, o1);
  if n <> 0 then raise exception 'FAIL: Recruit, Support or a voter was consulted'; end if;
  select count(*) into n from public.notifications where link = '/motions/' || m1::text and title like 'Vote needed%' and profile_id in (c1, c2, o1, o2, o3);
  if n <> 5 then raise exception 'FAIL: the voters should be notified (got %)', n; end if;
  select count(*) into n from public.notifications where link = '/motions/' || m1::text and title like 'Poll open%' and profile_id in (v_mem, v_mem2);
  if n <> 2 then raise exception 'FAIL: consulted members should be notified (got %)', n; end if;

  -- The wording is frozen once the vote opens; other edits are fine.
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin update public.agenda_items set vote_wording = 'Changed wording' where id = i_main; raise exception 'FAIL: wording changed after opening';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'wording_frozen' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin update public.agenda_items set kind = 'discuss' where id = i_main; raise exception 'FAIL: kind changed after opening';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  update public.agenda_items set planned_minutes = 12 where id = i_main;
  reset role;

  ------------------------------------------------------------------ choices hidden while open
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.cast_vote(m1, 'No');
  perform public.cast_vote(m1, 'Yes');                                 -- changeable until the chair closes
  begin perform public.cast_vote(m1, 'Maybe'); raise exception 'FAIL: bad option';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_option' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  select * into r from public.live_vote_progress(m1);
  if r.eligible <> 5 or r.voted <> 1 or r.my_vote <> 'Yes' or not r.is_voter or r.closed then raise exception 'FAIL: own progress wrong'; end if;
  select count(*) into n from public.motion_votes where motion_id = m1;
  if n <> 1 then raise exception 'FAIL: a voter reads only their own vote while open (got %)', n; end if;
  select count(*) into n from public.motion_log where motion_id = m1 and action in ('vote', 'vote_changed');
  if n <> 2 then raise exception 'FAIL: a voter reads their own log entries (got %)', n; end if;
  reset role;

  foreach body in array array['o2', 'c1', 'c2', 'adm', 'mem'] loop
    perform set_config('request.jwt.claims', json_build_object('sub',
      case body when 'o2' then o2 when 'c1' then c1 when 'c2' then c2 when 'adm' then v_adm else v_mem end, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.motion_votes where motion_id = m1;
    if n <> 0 then raise exception 'FAIL: % reads others'' choices while the vote is open', body; end if;
    select count(*) into n from public.motion_log where motion_id = m1 and action in ('vote', 'vote_changed', 'chair_vote');
    if n <> 0 then raise exception 'FAIL: % reads vote entries of the log while open', body; end if;
    select count(*) into n from public.motion_log where motion_id = m1 and action = 'opened';
    if n <> 1 then raise exception 'FAIL: % should still see the motion''s record', body; end if;
    select * into r from public.live_vote_progress(m1);
    if r.voted <> 1 then raise exception 'FAIL: % should see how many have voted', body; end if;
    reset role;
  end loop;

  -- The chair votes too; a majority of 5 does NOT close it: only the chair does.
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(m1, 'Yes'); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', c2, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(m1, 'Yes'); reset role;
  select count(*) into n from public.motions where id = m1 and state = 'open' and status = 'open' and live_closed_at is null;
  if n <> 1 then raise exception 'FAIL: a live vote must stay open until the chair closes it'; end if;
  perform public.process_motions(now() + interval '1000 hours');
  select count(*) into n from public.motions where id = m1 and state = 'open' and live_closed_at is null;
  if n <> 1 then raise exception 'FAIL: the deadline sweep must not close a live vote'; end if;

  ------------------------------------------------------------------ not eligible
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.cast_vote(m1, 'Yes'); raise exception 'FAIL: a consulted Member cast a counted vote';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_eligible' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rec, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.cast_vote(m1, 'Yes'); raise exception 'FAIL: a Recruit voted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  select count(*) into n from public.motions where id = m1;
  if n <> 0 then raise exception 'FAIL: a Recruit sees the live motion'; end if;
  reset role;

  ------------------------------------------------------------------ advisory poll
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.motions where id = m1;
  if n <> 1 then raise exception 'FAIL: a consulted Member sees the motion'; end if;
  perform public.cast_advisory_vote(m1, 'Yes');
  perform public.cast_advisory_vote(m1, 'No');
  begin perform public.cast_advisory_vote(m1, 'Maybe'); raise exception 'FAIL: advisory bad option';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_option' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  select * into r from public.live_vote_progress(m1);
  if not r.is_consulted or r.my_advisory <> 'No' or r.advisory_voted <> 1 then raise exception 'FAIL: advisory progress wrong'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.cast_advisory_vote(m1, 'Yes'); raise exception 'FAIL: a voter cast an advisory vote';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_eligible' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.motion_advisory_votes where motion_id = m1;
  if n <> 0 then raise exception 'FAIL: advisory choices leak while open'; end if;
  reset role;

  ------------------------------------------------------------------ chair records a vote for a voter who cannot use the app
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.record_vote_for(m1, o3, 'Yes', 'Fake: present, no phone'); raise exception 'FAIL: a voter recorded for another';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.record_vote_for(m1, o3, 'Yes', 'x'); raise exception 'FAIL: recorded without a note';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.record_vote_for(m1, c1, 'Yes', 'Fake: for myself'); raise exception 'FAIL: chair recorded for self';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'own_vote' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.record_vote_for(m1, v_mem, 'Yes', 'Fake: not a voter'); raise exception 'FAIL: recorded for a non-voter';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_eligible' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.record_vote_for(m1, o1, 'Yes', 'Fake: already voted'); raise exception 'FAIL: overwrote a voter''s own vote';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'already_voted' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.record_vote_for(m1, o3, 'Yes', 'Fake: present, no phone');
  reset role;
  select count(*) into n from public.motion_votes where motion_id = m1 and voter_id = o3 and recorded_by = c1 and record_note = 'Fake: present, no phone' and option = 'Yes';
  if n <> 1 then raise exception 'FAIL: chair-recorded vote not flagged'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', o3, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.cast_vote(m1, 'No'); raise exception 'FAIL: changed a chair-recorded vote';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'recorded_by_chair' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  ------------------------------------------------------------------ closing: the chair, once
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.close_live_vote(m1); raise exception 'FAIL: a voter closed the vote';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  res := public.close_live_vote(m1);
  reset role;
  if res <> 'passed' then raise exception 'FAIL: 4 Yes of 5 should pass (got %)', res; end if;
  select count(*) into n from public.motions where id = m1 and state = 'closed' and status = 'decided' and outcome_option = 'Yes'
     and live_result = 'passed' and live_closed_at is not null;
  if n <> 1 then raise exception 'FAIL: closed motion not stored as passed'; end if;
  select count(*) into n from public.notifications where link = '/motions/' || m1::text and title like 'Vote closed%' and profile_id in (c1, o1, v_mem);
  if n <> 3 then raise exception 'FAIL: voters and consulted members should get the result (got %)', n; end if;

  -- Revealed on close, by name, to everyone who can see it; recorded-by-chair is visible.
  foreach body in array array['o2', 'mem'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', case body when 'o2' then o2 else v_mem end, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.motion_votes where motion_id = m1;
    if n <> 4 then raise exception 'FAIL: % should now read all 4 votes (got %)', body, n; end if;
    select count(*) into n from public.motion_votes where motion_id = m1 and recorded_by is not null and voter_callsign = 'Fake-O3';
    if n <> 1 then raise exception 'FAIL: % should see the chair-recorded flag', body; end if;
    select count(*) into n from public.motion_log where motion_id = m1 and action = 'chair_vote';
    if n <> 1 then raise exception 'FAIL: % should now read the chair-vote log entry', body; end if;
    select count(*) into n from public.motion_advisory_votes where motion_id = m1;
    if n <> 1 then raise exception 'FAIL: % should now read the advisory poll', body; end if;
    reset role;
  end loop;

  -- A closed vote cannot be reopened, edited, voted on or re-closed.
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.close_live_vote(m1); raise exception 'FAIL: closed twice';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'motion_closed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.cast_vote(m1, 'No'); raise exception 'FAIL: voted after close';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'motion_closed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.record_vote_for(m1, o2, 'Yes', 'Fake: late record'); raise exception 'FAIL: recorded after close';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'motion_closed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.open_live_vote(i_main); raise exception 'FAIL: reopened a closed vote';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'already_opened' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.withdraw_motion(m1, 'Fake reason to withdraw'); raise exception 'FAIL: withdrew a closed vote';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  select count(*) into n from public.motion_log where motion_id = m1 and action = 'live_closed' and detail like 'passed: yes 4, no 0, abstain 0 of 5 eligible, 4 cast';
  if n <> 1 then raise exception 'FAIL: close not logged with the counts'; end if;

  ------------------------------------------------------------------ minutes carry the vote by name
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  body := (select body_md from public.minutes where id = public.create_minutes_from_agenda(ag));
  reset role;
  if body not like '%Shall the fake bylaw be adopted as written?%' or body not like '%**Result:** Passed%'
     or body not like '%Fake-C1: Yes%' or body not like '%Fake-O3: Yes (recorded by chair for Fake-O3: Fake: present, no phone)%'
     or body not like '%Advisory poll (consulted members, not counted):** Yes 0, No 1, Abstain 0%' then
    raise exception 'FAIL: minutes missing the result, names, chair flag or advisory counts: %', body;
  end if;

  ------------------------------------------------------------------ a tie goes to the Admin
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  m2 := public.open_live_vote(i_tie);
  perform public.cast_vote(m2, 'Yes');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', c2, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(m2, 'No'); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(m2, 'Abstain'); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  res := public.close_live_vote(m2);
  reset role;
  if res <> 'tie' then raise exception 'FAIL: 1/1/1 of 5 is a tie (got %)', res; end if;
  select count(*) into n from public.motions where id = m2 and status = 'escalated_final' and live_result = 'tie' and live_closed_at is not null;
  if n <> 1 then raise exception 'FAIL: a tie should wait for the Admin'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.motion_votes where motion_id = m2;
  if n <> 3 then raise exception 'FAIL: votes are revealed after a tied close (got %)', n; end if;
  begin perform public.cast_vote(m2, 'Yes'); raise exception 'FAIL: voted while awaiting the Admin';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.decide_motion_final(m2, 'Yes', 'Fake reason for the final call');
  reset role;
  select count(*) into n from public.motions where id = m2 and state = 'closed' and outcome_option = 'Yes' and decided_final_by = v_adm;
  if n <> 1 then raise exception 'FAIL: the Admin should be able to record the outcome'; end if;

  ------------------------------------------------------------------ quorum: a setting with no default
  select count(*) into n from public.meeting_vote_settings where quorum is null;
  if n <> 1 then raise exception 'FAIL: quorum must start with no value'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.set_vote_quorum(4); raise exception 'FAIL: Command set the quorum';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.set_vote_quorum(0); raise exception 'FAIL: quorum 0 accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_quorum' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.set_vote_quorum(4);
  reset role;
  select count(*) into n from public.settings_audit where event = 'vote_quorum_changed' and actor_id = v_adm and detail = 'none -> 4';
  if n <> 1 then raise exception 'FAIL: quorum change not logged'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  m3 := public.open_live_vote(i_quo);
  perform public.cast_vote(m3, 'Yes');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', c2, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(m3, 'Yes'); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(m3, 'Yes'); reset role;
  select quorum_at_open into n from public.motions where id = m3;
  if n <> 4 then raise exception 'FAIL: the quorum is snapshotted when the vote opens'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  res := public.close_live_vote(m3);
  reset role;
  if res <> 'no_quorum' then raise exception 'FAIL: 3 votes cast under a quorum of 4 is no quorum (got %)', res; end if;
  select count(*) into n from public.motions where id = m3 and state = 'closed' and status = 'decided' and outcome_option is null and live_result = 'no_quorum';
  if n <> 1 then raise exception 'FAIL: no quorum closes the vote with no outcome'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.set_vote_quorum(null); reset role;
  select count(*) into n from public.settings_audit where event = 'vote_quorum_changed' and detail = '4 -> none';
  if n <> 1 then raise exception 'FAIL: quorum cleared not logged'; end if;

  ------------------------------------------------------------------ fewer than 3 eligible voters
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  m4 := public.open_live_vote(i_few, null, array[c2, o1, o2]);       -- parties: c2, o1, o2 are out; c1 and o3 remain
  reset role;
  select count(*) into n from public.motion_voters where motion_id = m4 and profile_id in (c2, o1, o2);
  if n <> 0 then raise exception 'FAIL: parties must be excluded from the live vote'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.cast_vote(m4, 'Yes');
  res := public.close_live_vote(m4);
  reset role;
  if res <> 'tie' then raise exception 'FAIL: fewer than 3 eligible voters escalates (got %)', res; end if;
  select count(*) into n from public.motions where id = m4 and status = 'escalated_final';
  if n <> 1 then raise exception 'FAIL: fewer than 3 eligible waits for the Admin'; end if;

  ------------------------------------------------------------------ withdrawing before any vote frees the item
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  m5 := public.open_live_vote(i_wd);
  perform public.withdraw_motion(m5, 'Fake reason: opened by mistake');
  m5b := public.open_live_vote(i_wd);
  reset role;
  if m5b = m5 then raise exception 'FAIL: a fresh vote needs a fresh motion'; end if;
  select count(*) into n from public.motions where parent_id = i_wd;
  if n <> 2 then raise exception 'FAIL: both the withdrawn and the new motion are kept'; end if;

  ------------------------------------------------------------------ a standard motion is still open ballot (MVA-233 unchanged)
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  m5 := public.open_motion('general', 'Fake standard motion', '', null, null, null, 'old_guard');
  perform public.cast_vote(m5, 'Approve');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.motion_votes where motion_id = m5;
  if n <> 1 then raise exception 'FAIL: a standard motion must stay open ballot (got %)', n; end if;
  reset role;

  raise notice 'live meeting votes: ALL PASS';
end;
$$;

rollback;
