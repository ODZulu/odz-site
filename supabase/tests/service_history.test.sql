-- Tier 1 database tests for MVA-210: member service history (DOE, mission entries, RLS, authority).
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_adm  uuid := '00000000-0000-0000-0000-0000000000a9'; -- Admin
  v_cmd  uuid := '00000000-0000-0000-0000-0000000000b9'; -- Command
  v_og   uuid := '00000000-0000-0000-0000-0000000000c9'; -- Old Guard, seat holder, no edit_roster
  v_mem  uuid := '00000000-0000-0000-0000-0000000000d9'; -- Member, the target of the record
  v_mem2 uuid := '00000000-0000-0000-0000-0000000000e9'; -- a second Member: no relation to v_mem's record
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  entry_id uuid;
  n integer;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  insert into public.invites (code, tier_id)
  select 'svcfake00000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 15) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm,  'svc-adm@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"svcfake000000010"}'),
    (v_cmd,  'svc-cmd@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"svcfake000000011"}'),
    (v_og,   'svc-og@example.invalid',   'authenticated', 'authenticated', '{"invite_code":"svcfake000000012"}'),
    (v_mem,  'svc-mem@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"svcfake000000013"}'),
    (v_mem2, 'svc-mem2@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"svcfake000000014"}');
  update public.profiles set status = 'approved', is_admin = true, setup_complete = true, callsign = 'Fake-Svc-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Svc-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Svc-Og' where id = v_og;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Svc-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Svc-Mem2' where id = v_mem2;

  ------------------------------------------------------------------ who may set DOE and add entries
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.set_doe(v_mem, '2014-01-01'); raise exception 'FAIL: a plain Member set DOE for someone else';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.add_service_entry(v_mem, '2015-06-01', 'Road to Rostov', null, null, null, 'manual'); raise exception 'FAIL: a plain Member added an entry for someone else';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform public.set_doe(v_mem, '2014-01-01'); raise exception 'FAIL: anon set DOE';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ Command (edit_roster) sets DOE and adds entries
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_doe(v_mem, '2014-11-10');
  entry_id := public.add_service_entry(v_mem, '2015-06-01', 'Road to Rostov', 'Rostov', 'Driver', 'First big one', 'manual');
  perform public.add_service_entry(v_mem, '2016-03-01', 'Second op', null, null, null, 'manual');
  reset role;

  select count(*) into n from public.service_records where profile_id = v_mem and doe = '2014-11-10';
  if n <> 1 then raise exception 'FAIL: DOE not saved'; end if;
  select count(*) into n from public.service_history where profile_id = v_mem;
  if n <> 2 then raise exception 'FAIL: expected 2 entries (got %)', n; end if;

  ------------------------------------------------------------------ validation
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.add_service_entry(v_mem, null, 'No date', null, null, null, 'manual'); raise exception 'FAIL: a null date was accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_date' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.add_service_entry(v_mem, '2015-06-01', '', null, null, null, 'manual'); raise exception 'FAIL: an empty title was accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_title' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.add_service_entry(v_mem, '2015-06-01', repeat('x', 81), null, null, null, 'manual'); raise exception 'FAIL: an 81-character title was accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_title' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  ------------------------------------------------------------------ edit and delete
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.update_service_entry(entry_id, '2015-06-02', 'Road to Rostov (corrected)', 'Rostov', 'Driver', 'Fixed the date');
  reset role;
  select count(*) into n from public.service_history where id = entry_id and event_date = '2015-06-02' and title = 'Road to Rostov (corrected)';
  if n <> 1 then raise exception 'FAIL: edit did not apply'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_mem2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.delete_service_entry(entry_id); raise exception 'FAIL: a plain Member deleted an entry';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.delete_service_entry(entry_id);
  begin perform public.delete_service_entry(entry_id); raise exception 'FAIL: deleting twice should fail the second time';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_found' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select count(*) into n from public.service_history where profile_id = v_mem;
  if n <> 1 then raise exception 'FAIL: expected 1 entry left after delete (got %)', n; end if;

  ------------------------------------------------------------------ RLS: self, Old Guard/Command, edit_roster and Admin can read; an unrelated Member cannot
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.service_records where profile_id = v_mem;
  if n <> 1 then raise exception 'FAIL: a member should read their own service record'; end if;
  select count(*) into n from public.service_history where profile_id = v_mem;
  if n <> 1 then raise exception 'FAIL: a member should read their own history entries'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_mem2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.service_records where profile_id = v_mem;
  if n <> 0 then raise exception 'FAIL: an unrelated Member should not read someone else''s DOE'; end if;
  select count(*) into n from public.service_history where profile_id = v_mem;
  if n <> 0 then raise exception 'FAIL: an unrelated Member should not read someone else''s history'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_og, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.service_records where profile_id = v_mem;
  if n <> 1 then raise exception 'FAIL: Old Guard (seat holder) should read any member''s DOE'; end if;
  select count(*) into n from public.service_history where profile_id = v_mem;
  if n <> 1 then raise exception 'FAIL: Old Guard (seat holder) should read any member''s history'; end if;
  begin perform public.set_doe(v_mem, '2015-01-01'); raise exception 'FAIL: Old Guard without edit_roster set DOE';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.service_records where profile_id = v_mem;
  if n <> 1 then raise exception 'FAIL: Admin should read any member''s DOE'; end if;
  reset role;

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform count(*) from public.service_records; raise exception 'FAIL: anon read service_records';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform count(*) from public.service_history; raise exception 'FAIL: anon read service_history';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ history entries survive soft removal
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.remove_member(v_mem, 'Fake removal for service-history survival check');
  reset role;
  select count(*) into n from public.service_history where profile_id = v_mem;
  if n <> 1 then raise exception 'FAIL: history entries should survive a soft removal (got %)', n; end if;
  select count(*) into n from public.service_records where profile_id = v_mem and doe = '2014-11-10';
  if n <> 1 then raise exception 'FAIL: DOE should survive a soft removal'; end if;

  raise notice 'service_history: ALL PASS';
end;
$$;

rollback;
