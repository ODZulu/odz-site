-- Tier 1 database tests for MVA-233: Command motions and votes.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_adm uuid := '00000000-0000-0000-0000-0000000000a1';
  c1 uuid := '00000000-0000-0000-0000-0000000000c1';
  c2 uuid := '00000000-0000-0000-0000-0000000000c2';
  c3 uuid := '00000000-0000-0000-0000-0000000000c3';
  o1 uuid := '00000000-0000-0000-0000-0000000000b1';
  o2 uuid := '00000000-0000-0000-0000-0000000000b2';
  o3 uuid := '00000000-0000-0000-0000-0000000000b3';
  o4 uuid := '00000000-0000-0000-0000-0000000000b4';
  v_mem uuid := '00000000-0000-0000-0000-0000000000d1';
  v_par uuid := '00000000-0000-0000-0000-0000000000d2';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  ma uuid; mb uuid; mc uuid; md uuid; me uuid; mf uuid; mg uuid; mh uuid; mi uuid; mj uuid; mk uuid;
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
  select 'motfake00000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 20) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm, 'adm@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"motfake0000000010"}'),
    (c1,    'c1@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"motfake0000000011"}'),
    (c2,    'c2@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"motfake0000000012"}'),
    (c3,    'c3@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"motfake0000000013"}'),
    (o1,    'o1@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"motfake0000000014"}'),
    (o2,    'o2@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"motfake0000000015"}'),
    (o3,    'o3@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"motfake0000000016"}'),
    (o4,    'o4@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"motfake0000000017"}'),
    (v_mem, 'mem@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"motfake0000000018"}'),
    (v_par, 'par@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"motfake0000000019"}');
  update public.profiles set status = 'approved', tier_id = t_mem, is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-C1' where id = c1;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-C2' where id = c2;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-C3' where id = c3;
  update public.profiles set tier_id = t_cmd where id in (c1, c2, c3);
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-O1' where id = o1;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-O2' where id = o2;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-O3' where id = o3;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-O4' where id = o4;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Par' where id = v_par;

  -- Command may open motions; Old Guard and Member may not.
  select count(*) into n from public.tier_capabilities tc join public.tiers t on t.id = tc.tier_id
   where tc.capability_key = 'open_motions' and t.seat_group = 'command';
  if n <> 1 then raise exception 'FAIL: Command should hold open_motions'; end if;
  select count(*) into n from public.tier_capabilities tc where tc.capability_key = 'open_motions';
  if n <> 1 then raise exception 'FAIL: only Command holds open_motions by default (got %)', n; end if;

  ------------------------------------------------------------------ who may open
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.open_motion('dispute', 'Fake dispute'); raise exception 'FAIL: Old Guard opened a motion';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.open_motion('dispute', 'Fake dispute'); raise exception 'FAIL: Member opened a motion';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform public.open_motion('dispute', 'Fake dispute'); raise exception 'FAIL: anon opened a motion';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform count(*) from public.motions; raise exception 'FAIL: anon read motions';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.cast_vote('00000000-0000-0000-0000-000000000001', 'Approve'); raise exception 'FAIL: anon voted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.process_motions(); raise exception 'FAIL: anon ran process_motions';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- Option and body validation.
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.open_motion('dispute', 'Fake', '', null, null, '["Only"]'::jsonb); raise exception 'FAIL: one option accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_options' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.open_motion('dispute', 'Fake', '', null, null, '["A","A"]'::jsonb); raise exception 'FAIL: duplicate options accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_options' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.open_motion('dispute', 'Fake', '', null, null, null, 'everyone'); raise exception 'FAIL: bad body accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_body' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  ------------------------------------------------------------------ motion A: opens, snapshots, visibility, early majority
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ma := public.open_motion('expense_dispute', 'Fake dispute A', 'Fake description', 'fake_subject', gen_random_uuid(),
                           null, 'command', 72, array[v_par]);
  reset role;
  select count(*) into n from public.motion_voters where motion_id = ma and round = 1;
  if n <> 3 then raise exception 'FAIL: Command snapshot should be the 3 Command members (got %)', n; end if;
  select count(*) into n from public.motions where id = ma and state = 'open' and status = 'open' and round = 1
     and options = '["Approve","Reject"]'::jsonb and deadline > now() + interval '71 hours' and deadline < now() + interval '73 hours';
  if n <> 1 then raise exception 'FAIL: motion A should be open with default options and a 72h deadline'; end if;
  select count(*) into n from public.notifications where kind = 'motion' and link = '/motions/' || ma::text and title like 'Vote needed%';
  if n <> 3 then raise exception 'FAIL: the 3 eligible voters should be notified on open (got %)', n; end if;
  select count(*) into n from public.notifications where kind = 'motion' and link = '/motions/' || ma::text and profile_id in (o1, v_mem, v_par);
  if n <> 0 then raise exception 'FAIL: non-voters should not get the opened notice'; end if;

  -- Visibility: Old Guard, Command, Admin and the party see it; a Member who is not a party does not.
  foreach s in array array['c1', 'o1', 'adm', 'par'] loop
    perform set_config('request.jwt.claims', json_build_object('sub',
      case s when 'c1' then c1 when 'o1' then o1 when 'adm' then v_adm else v_par end, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.motions where id = ma;
    if n <> 1 then raise exception 'FAIL: % should see motion A', s; end if;
    select count(*) into n from public.motion_voters where motion_id = ma;
    if n <> 3 then raise exception 'FAIL: % should see the voter list', s; end if;
    reset role;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.motions;
  if n <> 0 then raise exception 'FAIL: a Member who is not a party sees no motions'; end if;
  select count(*) into n from public.motion_log;
  if n <> 0 then raise exception 'FAIL: a Member sees no motion log'; end if;
  begin perform public.cast_vote(ma, 'Approve'); raise exception 'FAIL: non-member voted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_found' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.motion_result(ma); n := 0; end;
  select count(*) into n from public.motion_result(ma);
  if n <> 0 then raise exception 'FAIL: result leaked to a non-member'; end if;
  reset role;

  -- A party sees the motion but cannot vote on it.
  perform set_config('request.jwt.claims', json_build_object('sub', v_par, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.cast_vote(ma, 'Approve'); raise exception 'FAIL: party voted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_eligible' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  -- Old Guard (not in the Command body) cannot vote either.
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.cast_vote(ma, 'Approve'); raise exception 'FAIL: Old Guard voted on a Command motion';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_eligible' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  -- Direct table writes are closed to clients.
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin insert into public.motion_votes (motion_id, round, voter_id, option) values (ma, 1, c1, 'Approve'); raise exception 'FAIL: direct vote insert allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin update public.motions set status = 'decided', outcome_option = 'Approve' where id = ma; raise exception 'FAIL: direct status update allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin delete from public.motion_votes where motion_id = ma; raise exception 'FAIL: direct vote delete allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.motion_voters (motion_id, round, profile_id) values (ma, 1, o1); raise exception 'FAIL: direct voter insert allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- c1 votes, changes, changes back: every step is logged with before/after.
  perform public.cast_vote(ma, 'Approve');
  perform public.cast_vote(ma, 'Reject');
  perform public.cast_vote(ma, 'Reject');                   -- same choice: no log row
  perform public.cast_vote(ma, 'Approve');
  begin perform public.cast_vote(ma, 'Maybe'); raise exception 'FAIL: unknown option accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_option' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select count(*) into n from public.motion_log where motion_id = ma and action = 'vote' and actor_id = c1 and option_from is null and option_to = 'Approve';
  if n <> 1 then raise exception 'FAIL: first vote not logged'; end if;
  select count(*) into n from public.motion_log where motion_id = ma and action = 'vote_changed' and actor_id = c1;
  if n <> 2 then raise exception 'FAIL: two changes should be logged (got %)', n; end if;
  select count(*) into n from public.motion_log where motion_id = ma and action = 'vote_changed' and option_from = 'Approve' and option_to = 'Reject';
  if n <> 1 then raise exception 'FAIL: change not logged with before and after'; end if;
  select count(*) into n from public.motion_votes where motion_id = ma;
  if n <> 1 then raise exception 'FAIL: one vote row per voter (got %)', n; end if;
  select count(*) into n from public.motions where id = ma and state = 'open';
  if n <> 1 then raise exception 'FAIL: one vote of three must not decide'; end if;

  -- The second Approve is a strict majority of 3 voters: decided at once, before the deadline.
  perform set_config('request.jwt.claims', json_build_object('sub', c2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.cast_vote(ma, 'Approve');
  reset role;
  select count(*) into n from public.motions where id = ma and state = 'closed' and status = 'decided' and outcome_option = 'Approve' and decided_final_by is null;
  if n <> 1 then raise exception 'FAIL: 2 of 3 should decide Approve early'; end if;
  select count(*) into n from public.notifications where kind = 'motion' and link = '/motions/' || ma::text and title like 'Decided%';
  if n < 3 then raise exception 'FAIL: the result should be sent to everyone who can see it (got %)', n; end if;
  select count(*) into n from public.notifications where kind = 'motion' and link = '/motions/' || ma::text and title like 'Decided%' and profile_id = v_par;
  if n <> 1 then raise exception 'FAIL: the party should be told the result'; end if;

  -- After the close: no more votes, and the result hook answers for those who may see it.
  perform set_config('request.jwt.claims', json_build_object('sub', c3, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.cast_vote(ma, 'Reject'); raise exception 'FAIL: voted after close';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'motion_closed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  select * into r from public.motion_result(ma);
  if r.status <> 'decided' or r.outcome_option <> 'Approve' or r.final then raise exception 'FAIL: motion_result wrong'; end if;
  select count(*) into n from public.motions_for_subject('fake_subject', (select subject_id from public.motions where id = ma));
  if n <> 1 then raise exception 'FAIL: motions_for_subject should list the motion'; end if;
  reset role;

  -- Nothing is ever deleted; the log is never edited, even by the table owner.
  begin delete from public.motions where id = ma; raise exception 'FAIL: motion deleted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin delete from public.motion_votes where motion_id = ma; raise exception 'FAIL: vote deleted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin update public.motion_log set detail = 'edited' where motion_id = ma; raise exception 'FAIL: log edited';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin delete from public.motion_log where motion_id = ma; raise exception 'FAIL: log deleted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin delete from public.motion_parties where motion_id = ma; raise exception 'FAIL: party deleted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ motion B: recusal, escalation to the Old Guard, final decision
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  mb := public.open_motion('dispute', 'Fake dispute B', '', null, null, '["Upheld","Corrected","Voided"]'::jsonb);
  begin perform public.cast_vote(mb, 'Approve'); raise exception 'FAIL: option outside the subject list accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_option' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', c3, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.recuse_from_motion(mb, 'x'); raise exception 'FAIL: recusal without a real reason accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.recuse_from_motion(mb, 'Fake conflict of interest');
  -- Recused: no vote slot, cannot vote, cannot see their own slot.
  select count(*) into n from public.motion_voters where motion_id = mb and round = 1 and profile_id = c3;
  if n <> 0 then raise exception 'FAIL: a recused member still has a vote slot'; end if;
  reset role;
  select count(*) into n from public.motion_recusals where motion_id = mb and profile_id = c3 and reason = 'Fake conflict of interest';
  if n <> 1 then raise exception 'FAIL: recusal not recorded with its reason'; end if;
  select count(*) into n from public.motion_log where motion_id = mb and action = 'recused' and actor_id = c3 and detail = 'Fake conflict of interest';
  if n <> 1 then raise exception 'FAIL: recusal not logged'; end if;

  -- Two eligible voters left: fewer than 3 escalates to the Old Guard at once (round 2), minus the recused member.
  select count(*) into n from public.motions where id = mb and status = 'escalated' and round = 2 and body = 'old_guard' and state = 'open';
  if n <> 1 then raise exception 'FAIL: motion B should have escalated to the Old Guard'; end if;
  select count(*) into n from public.motion_voters where motion_id = mb and round = 2;
  if n <> 6 then raise exception 'FAIL: round 2 should be c1, c2, o1-o4 (got %)', n; end if;
  select count(*) into n from public.motion_voters where motion_id = mb and round = 2 and profile_id = c3;
  if n <> 0 then raise exception 'FAIL: the recused member carried into round 2'; end if;
  select count(*) into n from public.motion_log where motion_id = mb and action = 'escalated';
  if n <> 1 then raise exception 'FAIL: the escalation is logged'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', c3, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.cast_vote(mb, 'Upheld'); raise exception 'FAIL: recused member voted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_eligible' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  -- 3-3 split of 6: no option can reach 4, so it ends at once as final-pending.
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(mb, 'Upheld'); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(mb, 'Upheld'); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', o3, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(mb, 'Upheld'); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(mb, 'Corrected'); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', c2, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(mb, 'Corrected'); reset role;
  select count(*) into n from public.motions where id = mb and status = 'open' or (id = mb and status = 'escalated' and state = 'open');
  if n <> 1 then raise exception 'FAIL: 3-2 with one vote outstanding is still open'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', o4, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cast_vote(mb, 'Voided'); reset role;
  select count(*) into n from public.motions where id = mb and status = 'escalated_final' and state = 'open';
  if n <> 1 then raise exception 'FAIL: 3/2/1 of 6 should end in escalated_final'; end if;

  -- Only an Admin closes it.
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.decide_motion_final(mb, 'Upheld', 'Fake reason'); raise exception 'FAIL: Command recorded the final outcome';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.cast_vote(mb, 'Voided'); raise exception 'FAIL: vote accepted while awaiting final decision';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'motion_closed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.decide_motion_final(mb, 'Upheld', 'x'); raise exception 'FAIL: final outcome without a reason';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.decide_motion_final(mb, 'Approve', 'Fake reason'); raise exception 'FAIL: final outcome outside the options';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_option' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.decide_motion_final(mb, 'Upheld', 'Fake reason for the final call');
  select * into r from public.motion_result(mb);
  if r.status <> 'decided' or r.outcome_option <> 'Upheld' or not r.final then raise exception 'FAIL: final result wrong'; end if;
  begin perform public.decide_motion_final(mb, 'Voided', 'Fake reason again'); raise exception 'FAIL: decided twice';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_awaiting_final' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select count(*) into n from public.motion_log where motion_id = mb and action = 'final_decided' and actor_id = v_adm and detail = 'Fake reason for the final call';
  if n <> 1 then raise exception 'FAIL: final decision not logged with the reason'; end if;
  -- Round 1 and round 2 votes stay apart.
  select count(*) into n from public.motion_votes where motion_id = mb and round = 2;
  if n <> 6 then raise exception 'FAIL: round 2 should hold 6 votes (got %)', n; end if;

  ------------------------------------------------------------------ recusal after voting is refused
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  mc := public.open_motion('dispute', 'Fake dispute C');
  perform public.cast_vote(mc, 'Approve');
  begin perform public.recuse_from_motion(mc, 'Fake reason to leave'); raise exception 'FAIL: recused after voting';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'already_voted' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  -- ...and cannot withdraw once a vote exists.
  begin perform public.withdraw_motion(mc, 'Fake reason to withdraw'); raise exception 'FAIL: withdrawn after a vote';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'votes_cast' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  ------------------------------------------------------------------ withdrawal
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  md := public.open_motion('dispute', 'Fake dispute D');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.withdraw_motion(md, 'Fake reason to withdraw'); raise exception 'FAIL: Old Guard withdrew a motion';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.withdraw_motion(md, 'Fake reason to withdraw'); raise exception 'FAIL: Member withdrew a motion';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', c2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.withdraw_motion(md, ' '); raise exception 'FAIL: withdrawal without a reason';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.withdraw_motion(md, 'Fake reason to withdraw');       -- another Command member may
  begin perform public.cast_vote(md, 'Approve'); raise exception 'FAIL: voted on a withdrawn motion';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'motion_closed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select count(*) into n from public.motions where id = md and state = 'closed' and status = 'withdrawn' and withdraw_reason = 'Fake reason to withdraw';
  if n <> 1 then raise exception 'FAIL: withdrawal not stored'; end if;
  select count(*) into n from public.motion_log where motion_id = md and action = 'withdrawn' and actor_id = c2;
  if n <> 1 then raise exception 'FAIL: withdrawal not logged'; end if;

  ------------------------------------------------------------------ deadlines: reminder, lapse, escalation
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  me := public.open_motion('dispute', 'Fake dispute E', '', null, null, null, 'command', 72);
  perform public.cast_vote(me, 'Approve');
  reset role;
  perform public.process_motions(now() + interval '10 hours');         -- too early: nothing
  select count(*) into n from public.notifications where link = '/motions/' || me::text and title like 'Vote closes%';
  if n <> 0 then raise exception 'FAIL: reminder sent too early'; end if;
  perform public.process_motions(now() + interval '50 hours');         -- inside the last 24h
  select count(*) into n from public.notifications where link = '/motions/' || me::text and title like 'Vote closes%';
  if n <> 2 then raise exception 'FAIL: reminder goes to the 2 voters who have not voted (got %)', n; end if;
  select count(*) into n from public.notifications where link = '/motions/' || me::text and title like 'Vote closes%' and profile_id = c1;
  if n <> 0 then raise exception 'FAIL: the voter who already voted got a reminder'; end if;
  perform public.process_motions(now() + interval '51 hours');
  select count(*) into n from public.notifications where link = '/motions/' || me::text and title like 'Vote closes%';
  if n <> 2 then raise exception 'FAIL: reminder repeated'; end if;
  -- Deadline passes with 1 of 3: no majority = tie, escalates to the Old Guard.
  perform public.process_motions(now() + interval '80 hours');
  select count(*) into n from public.motions where id = me and round = 2 and status = 'escalated' and body = 'old_guard';
  if n <> 1 then raise exception 'FAIL: lapsed motion should escalate to the Old Guard'; end if;
  select count(*) into n from public.motion_voters where motion_id = me and round = 2;
  if n <> 7 then raise exception 'FAIL: round 2 should hold all 3 Command + 4 Old Guard (got %)', n; end if;
  -- Round 2 lapses with no majority: final-pending.
  update public.motions set deadline = now() - interval '1 minute' where id = me;
  perform public.process_motions();
  select count(*) into n from public.motions where id = me and status = 'escalated_final';
  if n <> 1 then raise exception 'FAIL: a lapsed Old Guard vote should wait for the Admin'; end if;

  -- A majority reached at the deadline decides (it would already have decided early; the deadline
  -- path must not re-open anything).
  perform public.process_motions(now() + interval '500 hours');
  select count(*) into n from public.motions where id = me and status = 'escalated_final';
  if n <> 1 then raise exception 'FAIL: processing again must change nothing'; end if;

  ------------------------------------------------------------------ drafts and the snapshot
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  mf := public.open_motion('dispute', 'Fake dispute F', '', null, null, null, 'command', 72, '{}', 'agenda_item', gen_random_uuid(), true);
  reset role;
  select count(*) into n from public.motions where id = mf and state = 'draft' and parent_type = 'agenda_item' and opened_at is null;
  if n <> 1 then raise exception 'FAIL: draft state and parent link'; end if;
  select count(*) into n from public.motion_voters where motion_id = mf;
  if n <> 0 then raise exception 'FAIL: a draft has no voter snapshot yet'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.motions where id = mf;
  if n <> 0 then raise exception 'FAIL: Old Guard sees a draft'; end if;
  begin perform public.start_motion(mf); raise exception 'FAIL: Old Guard started a draft';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', c2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.motions where id = mf;
  if n <> 1 then raise exception 'FAIL: Command sees a draft'; end if;
  begin perform public.cast_vote(mf, 'Approve'); raise exception 'FAIL: voted on a draft';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  perform public.start_motion(mf);
  reset role;
  select count(*) into n from public.motions where id = mf and state = 'open' and opened_at is not null;
  if n <> 1 then raise exception 'FAIL: draft did not open'; end if;
  select count(*) into n from public.motion_voters where motion_id = mf and round = 1;
  if n <> 3 then raise exception 'FAIL: snapshot is taken when the draft opens (got %)', n; end if;

  -- Later tier changes do not alter the snapshot.
  perform set_config('request.jwt.claims', '', true);
  update public.profiles set tier_id = t_mem where id = c3;
  select count(*) into n from public.motion_voters where motion_id = mf and round = 1;
  if n <> 3 then raise exception 'FAIL: the snapshot must not be recomputed'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', c3, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.cast_vote(mf, 'Reject');                                -- still in the snapshot
  reset role;
  perform set_config('request.jwt.claims', '', true);
  update public.profiles set tier_id = t_og where id = c3;
  update public.profiles set tier_id = t_cmd where id = c3;

  ------------------------------------------------------------------ parties, retired members, Old Guard body
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  mg := public.open_motion('dispute', 'Fake dispute G', '', null, null, null, 'old_guard', 72, array[o1, v_par]);
  reset role;
  select count(*) into n from public.motion_voters where motion_id = mg and round = 1;
  if n <> 6 then raise exception 'FAIL: Old Guard body is Command + Old Guard minus the party (got %)', n; end if;
  select count(*) into n from public.motion_voters where motion_id = mg and profile_id = o1;
  if n <> 0 then raise exception 'FAIL: a party was snapshotted as a voter'; end if;
  -- Parties see the motion; a retired Old Guard member does not become a voter.
  update public.profiles set status = 'retired' where id = o4;
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  mh := public.open_motion('dispute', 'Fake dispute H', '', null, null, null, 'old_guard');
  reset role;
  select count(*) into n from public.motion_voters where motion_id = mh and profile_id = o4;
  if n <> 0 then raise exception 'FAIL: a retired member was snapshotted'; end if;
  select count(*) into n from public.motion_voters where motion_id = mh;
  if n <> 6 then raise exception 'FAIL: expected 6 voters without the retired member (got %)', n; end if;
  -- A tie in an Old Guard first round has nowhere to escalate except the Admin.
  update public.motions set deadline = now() - interval '1 minute' where id = mh;
  perform public.process_motions();
  select count(*) into n from public.motions where id = mh and status = 'escalated_final';
  if n <> 1 then raise exception 'FAIL: an Old Guard motion with no majority waits for the Admin'; end if;

  ------------------------------------------------------------------ fewer than 3 eligible at open
  -- Party makes only 2 Command voters.
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  mi := public.open_motion('dispute', 'Fake dispute I', '', null, null, null, 'command', 72, array[c3]);
  reset role;
  select count(*) into n from public.motions where id = mi and round = 2 and status = 'escalated';
  if n <> 1 then raise exception 'FAIL: 2 eligible Command voters should escalate at once'; end if;
  select count(*) into n from public.motion_voters where motion_id = mi and round = 2;
  if n <> 5 then raise exception 'FAIL: round 2 is c1, c2, o1-o3 with the party out (got %)', n; end if;

  ------------------------------------------------------------------ parent and subject hooks
  select count(*) into n from public.motions where parent_type = 'agenda_item' and id = mf;
  if n <> 1 then raise exception 'FAIL: parent link'; end if;

  raise notice 'motions: ALL PASS';
end;
$$;

rollback;
