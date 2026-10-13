-- Tier 1 database tests for MVA-209: member removal (soft), hard delete, lock-out, purge, audit.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_adm  uuid := '00000000-0000-0000-0000-0000000000a1';
  v_adm2 uuid := '00000000-0000-0000-0000-0000000000a2';
  v_cmd  uuid := '00000000-0000-0000-0000-0000000000c1';
  v_mem  uuid := '00000000-0000-0000-0000-0000000000b1';
  v_mem2 uuid := '00000000-0000-0000-0000-0000000000b2';
  v_pend uuid := '00000000-0000-0000-0000-0000000000d1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  e1 uuid; tr1 uuid; mn1 uuid; inv_open uuid;
  n integer;
  b timestamptz;
  d text;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  insert into public.invites (code, tier_id)
  select 'rmfake00000000' || g, t_recruit from generate_series(10, 15) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm,  'adm@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"rmfake0000000010"}'),
    (v_adm2, 'adm2@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"rmfake0000000011"}'),
    (v_cmd,  'cmd@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"rmfake0000000012"}'),
    (v_mem,  'mem@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"rmfake0000000013"}'),
    (v_mem2, 'mem2@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"rmfake0000000014"}'),
    (v_pend, 'pend@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"rmfake0000000015"}');
  update public.profiles set status = 'approved', is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', is_admin = true, setup_complete = true, callsign = 'Fake-Adm2' where id = v_adm2;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem2' where id = v_mem2;
  update public.profiles set callsign = 'Fake-Pend' where id = v_pend;

  insert into public.member_private (profile_id, legal_name, dob, allergies, emergency_name, emergency_relationship, emergency_phone)
  values (v_mem, 'Fake Legal Name', date '1990-01-02', 'Fake allergy', 'Fake Contact', 'Friend', '555-010-0100');

  -- Things the member authored, an open invite they issued, and dependants that must go with them.
  insert into public.events (title, starts_at, created_by) values ('Fake event', now() + interval '2 days', v_mem) returning id into e1;
  insert into public.traffic (title, body, created_by) values ('Fake post', 'Fake body', v_mem) returning id into tr1;
  insert into public.minutes (title, meeting_date, created_by) values ('Fake minutes', current_date, v_mem) returning id into mn1;
  insert into public.event_rsvps (event_id, profile_id, response) values (e1, v_mem, 'in');
  insert into public.notifications (profile_id, kind, title, body) values (v_mem, 'test', 'Fake', 'Fake');
  insert into public.invites (code, tier_id, created_by) values ('rmfakeopen0000001', t_recruit, v_mem) returning id into inv_open;
  insert into auth.sessions (id, user_id) values (gen_random_uuid(), v_mem);

  ------------------------------------------------------------------ who may call it
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.remove_member(v_mem, 'Fake reason'); raise exception 'FAIL: Command removed a member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.delete_removed_member(v_mem, 'Fake reason'); raise exception 'FAIL: Command hard-deleted a member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_mem2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.remove_member(v_mem, 'Fake reason'); raise exception 'FAIL: Member removed a member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform public.remove_member(v_mem, 'Fake reason'); raise exception 'FAIL: anon removed a member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.delete_removed_member(v_mem, 'Fake reason'); raise exception 'FAIL: anon hard-deleted a member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform 1 from public.member_removals; raise exception 'FAIL: anon read the removal log';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  select count(*) into n from public.profiles where status = 'removed';
  if n <> 0 then raise exception 'FAIL: a refused call still removed someone'; end if;

  ------------------------------------------------------------------ Admin: validation and guards
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;

  begin perform public.remove_member(v_mem, ''); raise exception 'FAIL: empty reason accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.remove_member(v_mem, 'ab'); raise exception 'FAIL: 2-character reason accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.remove_member(v_mem, repeat('r', 501)); raise exception 'FAIL: 501-character reason accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.remove_member(v_adm, 'Fake reason'); raise exception 'FAIL: admin removed themselves';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'cannot_remove_self' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.remove_member(gen_random_uuid(), 'Fake reason'); raise exception 'FAIL: unknown profile accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_found' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.delete_removed_member(v_mem2, 'Fake reason'); raise exception 'FAIL: hard-deleted a member who was not removed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_removed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;

  -- 'removed' is reachable only through the RPC, even for an admin.
  begin update public.profiles set status = 'removed' where id = v_mem2; raise exception 'FAIL: direct status = removed accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  select count(*) into n from public.profiles where id = v_mem2 and status = 'approved';
  if n <> 1 then raise exception 'FAIL: direct removal attempt changed the profile'; end if;

  ------------------------------------------------------------------ Admin removes a member
  perform public.remove_member(v_mem, '  Fake reason: left the team  ');
  reset role;

  select count(*) into n from public.profiles
   where id = v_mem and status = 'removed' and removed_at is not null and removed_by = v_adm and not is_admin
     and callsign = 'Fake-Mem' and tier_id = t_mem;
  if n <> 1 then raise exception 'FAIL: profile not marked removed with callsign and tier kept'; end if;
  select count(*) into n from public.member_private where profile_id = v_mem;
  if n <> 0 then raise exception 'FAIL: private data not purged'; end if;
  select count(*) into n from public.notifications where profile_id = v_mem;
  if n <> 0 then raise exception 'FAIL: notifications not purged'; end if;
  select count(*) into n from public.invites where id = inv_open and revoked_at is not null;
  if n <> 1 then raise exception 'FAIL: open invite of the removed member not revoked'; end if;
  select count(*) into n from public.invites where code = 'rmfake0000000013' and revoked_at is null and used_by = v_mem;
  if n <> 1 then raise exception 'FAIL: the redeemed invite was altered'; end if;
  select banned_until into b from auth.users where id = v_mem;
  if b is null or b < now() + interval '50 years' then raise exception 'FAIL: auth user not banned'; end if;
  select count(*) into n from auth.sessions where user_id = v_mem;
  if n <> 0 then raise exception 'FAIL: sessions not ended'; end if;
  select count(*) into n from public.profile_audit where profile_id = v_mem and event = 'status' and old_value = 'approved' and new_value = 'removed' and actor_id = v_adm;
  if n <> 1 then raise exception 'FAIL: status change not in the profile audit'; end if;
  -- Authored content stays.
  select count(*) into n from public.events where id = e1 and created_by = v_mem;
  select count(*) + n into n from public.traffic where id = tr1 and created_by = v_mem;
  select count(*) + n into n from public.minutes where id = mn1 and created_by = v_mem;
  if n <> 3 then raise exception 'FAIL: authored content changed by soft removal (got %)', n; end if;

  -- Cannot remove twice, and a removed row is frozen for signed-in callers.
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.remove_member(v_mem, 'Fake reason'); raise exception 'FAIL: removed twice';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'already_removed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin update public.profiles set status = 'approved' where id = v_mem; raise exception 'FAIL: admin reinstated a removed member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin update public.profiles set tier_id = t_og where id = v_mem; raise exception 'FAIL: admin changed the tier of a removed member';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.approve_member(v_mem); raise exception 'FAIL: removed member approved';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  select count(*) into n from public.profiles where id = v_mem and status = 'removed';
  if n <> 1 then raise exception 'FAIL: removed member no longer removed'; end if;

  -- The log: Admin reads it, with the trimmed reason.
  select count(*) into n from public.member_removals where profile_id = v_mem and action = 'removed' and actor_id = v_adm
     and reason = 'Fake reason: left the team' and callsign = 'Fake-Mem';
  if n <> 1 then raise exception 'FAIL: admin cannot read the removal log row'; end if;
  select count(*) into n from public.list_audit(100, 0) a where a.kind = 'removal' and a.event = 'removed' and a.detail = 'Fake reason: left the team' and a.target = 'Fake-Mem';
  if n <> 1 then raise exception 'FAIL: removal missing from the admin audit feed'; end if;
  reset role;

  ------------------------------------------------------------------ the removed member is locked out of data
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.events;
  if n <> 0 then raise exception 'FAIL: removed member reads events'; end if;
  select count(*) into n from public.traffic;
  if n <> 0 then raise exception 'FAIL: removed member reads traffic'; end if;
  select count(*) into n from public.minutes;
  if n <> 0 then raise exception 'FAIL: removed member reads minutes'; end if;
  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'FAIL: removed member reads other profiles (got %)', n; end if;
  select count(*) into n from public.profiles where id = v_mem and status = 'removed';
  if n <> 1 then raise exception 'FAIL: removed member cannot see their own status'; end if;
  select count(*) into n from public.member_removals;
  if n <> 0 then raise exception 'FAIL: removed member reads the removal log'; end if;
  begin perform public.update_own_profile('x', 'y', 'z'); raise exception 'FAIL: removed member edited their profile';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.update_own_private('Fake', date '1990-01-01', null, 'None', 'Fake', 'Friend', '555-010-0100');
    raise exception 'FAIL: removed member wrote private details';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.event_rsvps (event_id, response) values (e1, 'in'); raise exception 'FAIL: removed member RSVPed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- Private data cannot come back for a removed account by any route.
  begin
    insert into public.member_private (profile_id, legal_name, dob, allergies, emergency_name, emergency_relationship, emergency_phone)
    values (v_mem, 'Fake Legal Name', date '1990-01-02', 'Fake allergy', 'Fake Contact', 'Friend', '555-010-0100');
    raise exception 'FAIL: private data written for a removed account';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ others: roster, audit visibility
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = v_mem;
  if n <> 0 then raise exception 'FAIL: a member still sees the removed profile'; end if;
  select count(*) into n from public.profiles p where p.status = 'removed';
  if n <> 0 then raise exception 'FAIL: a member sees removed profiles'; end if;
  select count(*) into n from public.traffic t left join public.profiles p on p.id = t.created_by where t.id = tr1 and p.id is null;
  if n <> 1 then raise exception 'FAIL: the removed author should not resolve for a member (shown as Former member)'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.member_removals;
  if n <> 0 then raise exception 'FAIL: Command reads the removal log'; end if;
  select count(*) into n from public.list_audit(100, 0) a where a.kind = 'removal';
  if n <> 0 then raise exception 'FAIL: the removal reason reached the Command audit feed'; end if;
  select count(*) into n from public.list_audit(100, 0) a where a.kind = 'profile' and a.event = 'status' and a.detail = 'approved -> removed';
  if n <> 1 then raise exception 'FAIL: Command should see the status change without a reason'; end if;
  reset role;

  ------------------------------------------------------------------ a pending account removed before setup
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.remove_member(v_pend, 'Fake created in error');
  reset role;
  begin
    insert into public.member_private (profile_id, legal_name, dob, allergies, emergency_name, emergency_relationship, emergency_phone)
    values (v_pend, 'Fake Legal Name', date '1990-01-02', 'Fake allergy', 'Fake Contact', 'Friend', '555-010-0100');
    raise exception 'FAIL: setup data written for an account removed before setup';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ hard delete
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.delete_removed_member(v_mem, 'ab'); raise exception 'FAIL: hard delete without a reason';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.delete_removed_member(v_mem, 'Fake privacy request');
  reset role;

  select count(*) into n from public.profiles where id = v_mem;
  if n <> 0 then raise exception 'FAIL: profile survived hard delete'; end if;
  select count(*) into n from auth.users where id = v_mem;
  if n <> 0 then raise exception 'FAIL: auth user survived hard delete'; end if;
  select count(*) into n from public.event_rsvps where profile_id = v_mem;
  if n <> 0 then raise exception 'FAIL: RSVPs survived hard delete'; end if;
  -- No FK errors and no orphans: authored content stays with a null author.
  select count(*) into n from public.events where id = e1 and created_by is null;
  select count(*) + n into n from public.traffic where id = tr1 and created_by is null;
  select count(*) + n into n from public.minutes where id = mn1 and created_by is null;
  select count(*) + n into n from public.invites where id = inv_open and created_by is null;
  select count(*) + n into n from public.invites where code = 'rmfake0000000013' and used_by is null;
  if n <> 5 then raise exception 'FAIL: authored content not detached cleanly by hard delete (got %)', n; end if;
  select count(*) into n from public.member_removals where profile_id = v_mem and action = 'deleted' and callsign = 'Fake-Mem' and reason = 'Fake privacy request';
  if n <> 1 then raise exception 'FAIL: hard delete not logged'; end if;
  select count(*) into n from public.member_removals where profile_id = v_mem;
  if n <> 2 then raise exception 'FAIL: removal log should keep both rows (got %)', n; end if;

  -- Editing the surviving content still works and still cannot set an author.
  update public.events set title = 'Fake event edited' where id = e1;
  select count(*) into n from public.events where id = e1 and title = 'Fake event edited' and created_by is null;
  if n <> 1 then raise exception 'FAIL: surviving event not editable'; end if;

  raise notice 'member_removal: ALL PASS';
end;
$$;

rollback;
