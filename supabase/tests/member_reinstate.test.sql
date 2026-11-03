-- Tier 1 database tests for MVA-249: reinstate a soft-removed member.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_adm  uuid := '00000000-0000-0000-0000-0000000000a7';
  v_cmd  uuid := '00000000-0000-0000-0000-0000000000a6';
  v_mem  uuid := '00000000-0000-0000-0000-0000000000b7';
  v_og   uuid := '00000000-0000-0000-0000-0000000000b6';
  v_cm2  uuid := '00000000-0000-0000-0000-0000000000b5';
  v_sup  uuid := '00000000-0000-0000-0000-0000000000b4';
  v_act  uuid := '00000000-0000-0000-0000-0000000000c7';
  v_ret  uuid := '00000000-0000-0000-0000-0000000000c6';
  v_pend uuid := '00000000-0000-0000-0000-0000000000c5';
  v_del  uuid := '00000000-0000-0000-0000-0000000000c4';
  t_cmd uuid; t_og uuid; t_mem uuid; t_sup uuid;
  d_treasurer uuid;
  n integer;
  r text;
  banned timestamptz;
  tally_before integer;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_sup from public.tiers where name = 'Support';
  select id into d_treasurer from public.designations where name = 'Treasurer';

  ------------------------------------------------------------------ seed fake accounts
  insert into public.invites (code, tier_id)
  select 'rinfake0000000' || to_char(g, 'FM00'), (select id from public.tiers where name = 'Recruit') from generate_series(10, 19) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm,  'rin-adm@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"rinfake000000010"}'),
    (v_cmd,  'rin-cmd@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"rinfake000000011"}'),
    (v_mem,  'rin-mem@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"rinfake000000012"}'),
    (v_og,   'rin-og@example.invalid',   'authenticated', 'authenticated', '{"invite_code":"rinfake000000013"}'),
    (v_cm2,  'rin-cm2@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"rinfake000000014"}'),
    (v_sup,  'rin-sup@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"rinfake000000015"}'),
    (v_act,  'rin-act@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"rinfake000000016"}'),
    (v_ret,  'rin-ret@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"rinfake000000017"}'),
    (v_pend, 'rin-pend@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"rinfake000000018"}'),
    (v_del,  'rin-del@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"rinfake000000019"}');
  update public.profiles set status = 'approved', is_admin = true, setup_complete = true, callsign = 'Fake-Rin-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Rin-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Rin-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Rin-Og' where id = v_og;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Rin-Cm2' where id = v_cm2;
  update public.profiles set tier_id = t_cmd where id = v_cm2;
  update public.profiles set status = 'approved', tier_id = t_sup, setup_complete = true, callsign = 'Fake-Rin-Sup' where id = v_sup;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Rin-Act' where id = v_act;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Rin-Ret' where id = v_ret;
  update public.profiles set setup_complete = true, callsign = 'Fake-Rin-Pend' where id = v_pend;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Rin-Del' where id = v_del;

  -- History that must survive removal and reinstatement; a designation held at removal; authored content.
  insert into public.service_records (profile_id, doe) values (v_og, date '2015-05-05');
  insert into public.member_designations (profile_id, designation_id) values (v_og, d_treasurer);
  insert into public.traffic (title, body, created_by) values ('Fake Rin notice', 'Fake body', v_mem);
  insert into public.member_private (profile_id, legal_name, dob, allergies, emergency_name, emergency_relationship, emergency_phone)
  values (v_mem, 'Fake Legal Name', date '1990-01-02', 'Fake allergy', 'Fake Contact', 'Friend', '555-010-0100');

  -- Retire one so we can prove a retired member is not "reinstatable".
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.retire_member(v_ret, null);

  ------------------------------------------------------------------ remove four members (Admin), then reinstate
  perform public.remove_member(v_mem, 'fake: left the team');
  perform public.remove_member(v_og, 'fake: left the team');
  perform public.remove_member(v_cm2, 'fake: left the team');
  perform public.remove_member(v_sup, 'fake: left the team');
  perform public.remove_member(v_del, 'fake: made in error');
  perform public.delete_removed_member(v_del, 'fake: made in error');
  reset role;

  select banned_until into banned from auth.users where id = v_mem;
  if banned is null or banned < now() + interval '50 years' then raise exception 'FAIL: removal should ban the sign-in'; end if;
  select count(*) into n from public.member_private where profile_id = v_mem;
  if n <> 0 then raise exception 'FAIL: removal should have purged private details'; end if;
  tally_before := public.seat_tally('old_guard');

  ------------------------------------------------------------------ who may reinstate
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.reinstate_member(v_mem, 'fake: back again'); raise exception 'FAIL: Command reinstated a member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform public.reinstate_member(v_mem, 'fake: back again'); raise exception 'FAIL: anon reinstated a member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_act, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.reinstate_member(v_mem, 'fake: back again'); raise exception 'FAIL: a plain Member reinstated a member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select count(*) into n from public.profiles where id = v_mem and status = 'removed';
  if n <> 1 then raise exception 'FAIL: a refused call should change nothing'; end if;

  ------------------------------------------------------------------ refusals as Admin
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.reinstate_member(v_mem, 'ab'); raise exception 'FAIL: 2-character reason accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.reinstate_member(v_mem, repeat('x', 501)); raise exception 'FAIL: 501-character reason accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.reinstate_member(v_mem, null); raise exception 'FAIL: null reason accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.reinstate_member(v_act, 'fake: not removed'); raise exception 'FAIL: reinstated an active member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_reinstatable' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.reinstate_member(v_ret, 'fake: not removed'); raise exception 'FAIL: reinstated a retired member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_reinstatable' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.reinstate_member(v_pend, 'fake: not removed'); raise exception 'FAIL: reinstated a pending account';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_reinstatable' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.reinstate_member(v_adm, 'fake: myself'); raise exception 'FAIL: reinstated myself';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_reinstatable' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.reinstate_member(v_del, 'fake: hard deleted'); raise exception 'FAIL: reinstated a hard-deleted account';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_found' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;

  ------------------------------------------------------------------ a Member comes back
  r := public.reinstate_member(v_mem, '  fake: back after a break  ');
  reset role;
  if r <> 'Member' then raise exception 'FAIL: expected the Member tier back (got %)', r; end if;
  select count(*) into n from public.profiles
   where id = v_mem and status = 'approved' and tier_id = t_mem and removed_at is null and removed_by is null and setup_complete = false;
  if n <> 1 then raise exception 'FAIL: reinstated profile should be approved, in the prior tier, with setup re-opened'; end if;
  select banned_until into banned from auth.users where id = v_mem;
  if banned is not null then raise exception 'FAIL: the sign-in ban should be lifted'; end if;
  select count(*) into n from public.profile_audit
   where profile_id = v_mem and event = 'member_reinstated' and actor_id = v_adm and old_value = 'Member' and new_value = 'Member' and note = 'fake: back after a break';
  if n <> 1 then raise exception 'FAIL: reinstatement audit row missing or wrong'; end if;
  select count(*) into n from public.profile_audit where event = 'member_reinstated' and (note like '%Fake Legal%' or old_value like '%Fake Legal%' or new_value like '%Fake Legal%');
  if n <> 0 then raise exception 'FAIL: no private values in the audit'; end if;
  -- Private details stay purged; authored content is attributable again; reinstatement does not re-invite.
  select count(*) into n from public.member_private where profile_id = v_mem;
  if n <> 0 then raise exception 'FAIL: private details must not come back'; end if;
  select count(*) into n from public.traffic where created_by = v_mem;
  if n <> 1 then raise exception 'FAIL: authored traffic should still point at the profile'; end if;

  -- The reinstated member is on the roster and can read it as an ordinary member.
  perform set_config('request.jwt.claims', json_build_object('sub', v_act, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = v_mem and status = 'approved';
  if n <> 1 then raise exception 'FAIL: reinstated member should be back on the roster'; end if;
  reset role;

  ------------------------------------------------------------------ seat tiers never come back as seats
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  r := public.reinstate_member(v_og, 'fake: back, was Old Guard');
  if r <> 'Member' then raise exception 'FAIL: a removed Old Guard member should return as Member (got %)', r; end if;
  r := public.reinstate_member(v_cm2, 'fake: back, was Command');
  if r <> 'Member' then raise exception 'FAIL: a removed Command member should return as Member, not Old Guard (got %)', r; end if;
  r := public.reinstate_member(v_sup, 'fake: back, was Support');
  if r <> 'Support' then raise exception 'FAIL: a removed Support member should return as Support (got %)', r; end if;
  reset role;
  select count(*) into n from public.profiles where id in (v_og, v_cm2) and tier_id = t_mem and status = 'approved';
  if n <> 2 then raise exception 'FAIL: both former seat holders should be Members'; end if;
  if public.seat_tally('old_guard') <> tally_before then raise exception 'FAIL: reinstatement must not take a seat'; end if;

  -- History kept; designations not restored and the clearing is logged.
  select count(*) into n from public.service_records where profile_id = v_og and doe = date '2015-05-05';
  if n <> 1 then raise exception 'FAIL: service record should still be there'; end if;
  select count(*) into n from public.member_designations where profile_id = v_og;
  if n <> 0 then raise exception 'FAIL: designations held at removal must not come back'; end if;
  select count(*) into n from public.designation_audit where profile_id = v_og and action = 'revoked' and designation_name = 'Treasurer' and actor_id = v_adm;
  if n <> 1 then raise exception 'FAIL: clearing the designation should be logged'; end if;

  -- Reinstating twice is refused (the account is active now).
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.reinstate_member(v_mem, 'fake: again'); raise exception 'FAIL: reinstated twice';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_reinstatable' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;

  -- Audit feed shows it to Admin.
  select count(*) into n from public.list_audit(100, 0) where event = 'member_reinstated' and target like 'Fake-Rin-%';
  if n < 4 then raise exception 'FAIL: reinstatements should show in the audit feed (got %)', n; end if;
  reset role;

  raise notice 'member reinstate: ALL PASS';
end;
$$;

rollback;
