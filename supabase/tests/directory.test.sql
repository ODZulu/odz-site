-- Tier 1 database tests for MVA-204: directory fields, own-profile edits, callsign changes,
-- own private details. Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_cmd   uuid := '00000000-0000-0000-0000-0000000000c1';
  v_mem   uuid := '00000000-0000-0000-0000-0000000000b1';
  v_mem2  uuid := '00000000-0000-0000-0000-0000000000b2';
  v_pend  uuid := '00000000-0000-0000-0000-0000000000d1';
  v_adm   uuid := '00000000-0000-0000-0000-0000000000a1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  n integer;
  j timestamptz;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  insert into public.invites (code, tier_id)
  select 'dirfake00000000' || g, t_recruit from generate_series(10, 14) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_cmd,  'cmd@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"dirfake0000000010"}'),
    (v_mem,  'mem@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"dirfake0000000011"}'),
    (v_mem2, 'mem2@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"dirfake0000000012"}'),
    (v_pend, 'pend@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"dirfake0000000013"}'),
    (v_adm,  'adm@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"dirfake0000000014"}');
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem2' where id = v_mem2;
  update public.profiles set status = 'approved', is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set setup_complete = true, callsign = 'Fake-Pend' where id = v_pend;
  insert into public.member_private (profile_id, legal_name, dob, allergies, emergency_name, emergency_relationship, emergency_phone)
  values (v_mem, 'Fake Legal Name', date '1990-01-02', 'Fake allergy', 'Fake Contact', 'Friend', '555 010 0100');

  ------------------------------------------------------------------ joined_at
  select joined_at into j from public.profiles where id = v_mem;
  if j is null then raise exception 'FAIL: joined_at not set on approval'; end if;
  select joined_at into j from public.profiles where id = v_pend;
  if j is not null then raise exception 'FAIL: joined_at set for a pending account'; end if;
  update public.profiles set status = 'suspended' where id = v_mem2;
  update public.profiles set status = 'approved' where id = v_mem2;
  select count(*) into n from public.profiles where id = v_mem2 and joined_at is not null;
  if n <> 1 then raise exception 'FAIL: joined_at lost on reinstatement'; end if;

  ------------------------------------------------------------------ own profile edits
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;

  perform public.update_own_profile('Fake Display', 'Medic', 'Fake bio text <script>x</script>');
  select count(*) into n from public.profiles where id = v_mem and display_name = 'Fake Display' and role_note = 'Medic' and bio like 'Fake bio%';
  if n <> 1 then raise exception 'FAIL: own profile not updated'; end if;

  begin perform public.update_own_profile('x', repeat('r', 61), 'b'); raise exception 'FAIL: 61-char role accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_role_note' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.update_own_profile('x', 'r', repeat('b', 281)); raise exception 'FAIL: 281-char bio accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_bio' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.update_own_profile('x', repeat('r', 60), repeat('b', 280));

  -- Direct updates of these columns, and of the callsign, are closed.
  begin update public.profiles set bio = 'direct' where id = v_mem; raise exception 'FAIL: direct bio update allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin update public.profiles set callsign = 'Fake-Direct' where id = v_mem; raise exception 'FAIL: direct callsign update allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin update public.profiles set tier_id = t_cmd where id = v_mem; n := 1; exception when others then n := 0; end;
  select count(*) into n from public.profiles where id = v_mem and tier_id = t_mem;
  if n <> 1 then raise exception 'FAIL: member changed own tier'; end if;

  -- A member cannot change the callsign (even their own).
  begin perform public.set_callsign(v_mem, 'Fake-Own'); raise exception 'FAIL: member changed a callsign';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Reading the directory: approved profiles only, none of the private columns.
  select count(*) into n from public.profiles where status = 'approved';
  if n <> 4 then raise exception 'FAIL: directory should list the 4 approved profiles (got %)', n; end if;
  select count(*) into n from public.profiles where status <> 'approved';
  if n <> 0 then raise exception 'FAIL: member should not see pending or suspended profiles (got %)', n; end if;
  select count(*) into n from public.member_private where profile_id <> v_mem;
  if n <> 0 then raise exception 'FAIL: member read another private row'; end if;

  -- Own private details: validated, fixed errors, no values echoed.
  perform public.update_own_private('Fake Legal Two', date '1990-01-03', '555 010 0111', 'None', 'Fake Contact B', 'Sibling', '555 010 0112');
  select count(*) into n from public.member_private where profile_id = v_mem and legal_name = 'Fake Legal Two' and phone = '555 010 0111';
  if n <> 1 then raise exception 'FAIL: own private details not updated'; end if;
  begin perform public.update_own_private('Fake', current_date + 1, null, 'None', 'Fake', 'Friend', '555 010 0100'); raise exception 'FAIL: future dob accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_dob' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.update_own_private('Fake', date '1990-01-01', null, '', 'Fake', 'Friend', '555 010 0100'); raise exception 'FAIL: blank allergies accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.update_own_private('Fake', date '1990-01-01', null, 'None', 'Fake', 'Friend', 'abc'); raise exception 'FAIL: bad emergency phone accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ pending and anon
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pend, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.update_own_profile('x', 'y', 'z'); raise exception 'FAIL: pending edited a profile';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  select count(*) into n from public.profiles where status = 'approved' and id <> v_pend;
  if n <> 0 then raise exception 'FAIL: pending account read the directory'; end if;

  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform 1 from public.profiles; raise exception 'FAIL: anon read profiles';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.update_own_profile('x', 'y', 'z'); raise exception 'FAIL: anon edited a profile';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ Command: callsign and private panel
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;

  perform public.set_callsign(v_mem2, '  Fake-Renamed ');
  select count(*) into n from public.profiles where id = v_mem2 and callsign = 'Fake-Renamed';
  if n <> 1 then raise exception 'FAIL: callsign not changed'; end if;
  begin perform public.set_callsign(v_mem2, 'fake-mem'); raise exception 'FAIL: duplicate callsign (different case) accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'callsign_taken' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.set_callsign(v_mem2, 'x'); raise exception 'FAIL: short callsign accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.set_callsign(v_mem2, 'bad!name'); raise exception 'FAIL: bad characters accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.set_callsign(v_adm, 'Fake-Boss'); raise exception 'FAIL: non-admin renamed an admin';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Command reads private details of others (read-only: they cannot edit).
  select count(*) into n from public.member_private where profile_id = v_mem;
  if n <> 1 then raise exception 'FAIL: command cannot read private details'; end if;
  update public.member_private set phone = '555 010 9999' where profile_id = v_mem;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: command edited private details'; end if;
  begin perform public.update_own_private('Fake', date '1990-01-01', null, 'None', 'Fake', 'Friend', '555 010 0100');
    raise exception 'FAIL: update_own_private worked without a private row';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ audit: field names only
  select count(*) into n from public.profile_audit where event = 'profile' and profile_id = v_mem and new_value = 'bio,display_name,role_note';
  if n < 1 then raise exception 'FAIL: own-profile edit not audited by field names (got %)', n; end if;
  select count(*) into n from public.profile_audit where event = 'profile' and profile_id = v_mem2 and new_value = 'callsign' and actor_id = v_cmd;
  if n <> 1 then raise exception 'FAIL: callsign change not audited with its actor'; end if;
  select count(*) into n from public.profile_audit where event = 'profile' and (new_value ~* 'Fake bio|Medic|Fake Display|Renamed|script' or old_value is not null);
  if n <> 0 then raise exception 'FAIL: profile audit leaked values'; end if;
  -- First-login setup is not logged as a profile edit.
  select count(*) into n from public.profile_audit where event = 'profile' and profile_id = v_pend;
  if n <> 0 then raise exception 'FAIL: setup callsign logged as an edit'; end if;

  raise notice 'directory: ALL PASS';
end;
$$;

rollback;
