-- Tier 1 database tests for MVA-199: invites, signup gate, private member data, approval RPCs.
-- Plain SQL, runs in one transaction that is rolled back. Fake users and fake values only
-- (the repo is public). Run against a dev or branch database, never one holding real members.
-- Success: the notice "invites_private: ALL PASS". Any failure raises an exception.

begin;

do $$
declare
  v_boot   uuid := '00000000-0000-0000-0000-0000000000f1';
  v_boot2  uuid := '00000000-0000-0000-0000-0000000000f2';
  v_cmd    uuid := '00000000-0000-0000-0000-0000000000c1';
  v_mem    uuid := '00000000-0000-0000-0000-0000000000b1';
  v_new    uuid := '00000000-0000-0000-0000-0000000000d1';
  v_new2   uuid := '00000000-0000-0000-0000-0000000000d2';
  v_other  uuid := '00000000-0000-0000-0000-0000000000d3';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid; t_contractor uuid;
  inv_code text;
  n integer;
  ok boolean;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';
  select id into t_contractor from public.tiers where name = 'Contractor';

  ------------------------------------------------------------------ initial admin
  -- Skipped on a database that already has its real admin.
  if not exists (select 1 from public.profiles where is_admin) then
    insert into auth.users (id, email, aud, role)
    values (v_boot, 'DetachmentZulu@gmail.com', 'authenticated', 'authenticated');
    select count(*) into n from public.profiles
      where id = v_boot and callsign = 'ODZ Admin' and display_name = 'ODZ Admin'
        and is_admin and status = 'approved' and setup_complete;
    if n <> 1 then raise exception 'FAIL: initial admin not created as ODZ Admin'; end if;
    -- Only while no admin exists: a second registration of that address needs an invite.
    begin
      insert into auth.users (id, email, aud, role)
      values (v_boot2, 'detachmentzulu@gmail.com', 'authenticated', 'authenticated');
      raise exception 'FAIL: bootstrap address skipped the invite after an admin existed';
    exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'Invite not valid' then raise exception 'FAIL: wrong rejection (%)', sqlerrm; end if; end;
  end if;

  -- Bootstrap fixtures (trusted, no JWT): a Command member and an approved Member.
  insert into public.invites (code, tier_id) values
    ('fakeinvite0000000001', t_recruit), ('fakeinvite0000000002', t_recruit), ('fakeinvite0000000005', t_recruit);
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_cmd, 'cmd@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"fakeinvite0000000001"}'),
    (v_mem, 'mem@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"fakeinvite0000000002"}');
  update public.profiles set status = 'approved', tier_id = t_og where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem where id = v_mem;

  ------------------------------------------------------------------ signup gate
  begin
    insert into auth.users (id, email, aud, role) values (v_new, 'new@example.invalid', 'authenticated', 'authenticated');
    raise exception 'FAIL: signup without an invite succeeded';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  begin
    insert into auth.users (id, email, aud, role, raw_user_meta_data)
    values (v_new, 'new@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"nosuchcode000000000"}');
    raise exception 'FAIL: signup with an unknown invite succeeded';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Already used (invite 1 was consumed above).
  begin
    insert into auth.users (id, email, aud, role, raw_user_meta_data)
    values (v_new, 'new@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"fakeinvite0000000001"}');
    raise exception 'FAIL: signup with a used invite succeeded';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  select count(*) into n from public.invites where used_by is not null;
  if n <> 2 then raise exception 'FAIL: expected 2 used invites (got %)', n; end if;
  select count(*) into n from public.invite_audit where event = 'used';
  if n <> 2 then raise exception 'FAIL: use not audited (got %)', n; end if;

  ------------------------------------------------------------------ Command issues invites
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;

  if not public.has_capability('view_member_private') then raise exception 'FAIL: command lacks view_member_private'; end if;

  -- Server-generated code, default Recruit, 7 day expiry, issuer recorded.
  insert into public.invites (note) values ('fake note') returning code into inv_code;
  select count(*) into n from public.invites
    where code = inv_code and length(code) >= 10 and tier_id = t_recruit and created_by = v_cmd
      and expires_at > now() + interval '6 days' and expires_at < now() + interval '8 days';
  if n <> 1 then raise exception 'FAIL: invite defaults wrong'; end if;

  -- Clients cannot choose the code, the expiry, or mark an invite used.
  begin
    insert into public.invites (code, tier_id) values ('chosenbyclient0000', t_recruit);
    raise exception 'FAIL: client supplied its own code';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    update public.invites set used_at = now() where code = inv_code;
    raise exception 'FAIL: client marked an invite used';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Only Recruit, Prospect and Contractor can be granted.
  insert into public.invites (tier_id, note) values (t_contractor, 'fake contractor');
  begin
    insert into public.invites (tier_id) values (t_cmd);
    raise exception 'FAIL: invite for Command allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    insert into public.invites (tier_id) values (t_mem);
    raise exception 'FAIL: invite for Member allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Revoke an unused invite; the audit log records it; it cannot be revoked twice.
  update public.invites set revoked_at = now() where code = 'fakeinvite0000000099';  -- no row, fine
  insert into public.invites (note) values ('to revoke');
  update public.invites set revoked_at = now() where note = 'to revoke';
  select count(*) into n from public.invite_audit where event = 'revoked' and actor_id = v_cmd;
  if n <> 1 then raise exception 'FAIL: revoke not audited (got %)', n; end if;
  begin
    update public.invites set revoked_at = null where note = 'to revoke';
    raise exception 'FAIL: un-revoked an invite';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  select count(*) into n from public.invite_audit where event = 'created' and actor_id = v_cmd;
  if n < 3 then raise exception 'FAIL: invite creation not audited (got %)', n; end if;

  ------------------------------------------------------------------ plain Member and anon
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.invites; if n <> 0 then raise exception 'FAIL: member read invites'; end if;
  select count(*) into n from public.invite_audit; if n <> 0 then raise exception 'FAIL: member read invite audit'; end if;
  begin
    insert into public.invites (tier_id) values (t_recruit);
    raise exception 'FAIL: member created an invite';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin
    perform 1 from public.invites;
    raise exception 'FAIL: anon read invites';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform 1 from public.member_private;
    raise exception 'FAIL: anon read member_private';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform 1 from public.invite_attempts;
    raise exception 'FAIL: anon read invite_attempts';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform public.redeem_invite('fakeinvite0000000005', v_mem);
    raise exception 'FAIL: anon called redeem_invite';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ check_invite (anon)
  reset role;
  select code into inv_code from public.invites where note = 'fake note';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.headers', '{"x-real-ip":"203.0.113.9"}', true);
  set local role anon;

  if not public.check_invite(inv_code) then raise exception 'FAIL: valid invite rejected'; end if;
  if not public.check_invite(upper(substr(inv_code, 1, 5)) || '-' || substr(inv_code, 6)) then
    raise exception 'FAIL: formatting (case, dash) should not matter';
  end if;
  if public.check_invite('fakeinvite0000000001') then raise exception 'FAIL: used invite accepted'; end if;
  if public.check_invite('') then raise exception 'FAIL: empty code accepted'; end if;

  -- Lockout: 5 failures in total (3 so far) then even a valid code is refused.
  ok := public.check_invite('wrongwrongwrong0001');
  ok := public.check_invite('wrongwrongwrong0002');
  ok := public.check_invite('wrongwrongwrong0003');
  if public.check_invite(inv_code) then raise exception 'FAIL: not locked out after 5 failures'; end if;

  -- A different source is not locked by someone else's failures.
  perform set_config('request.headers', '{"x-real-ip":"203.0.113.10"}', true);
  if not public.check_invite(inv_code) then raise exception 'FAIL: other source wrongly locked out'; end if;

  -- Lock expires.
  reset role;
  update public.invite_attempts set locked_until = now() - interval '1 minute' where key = 'ip:203.0.113.9';
  perform set_config('request.headers', '{"x-real-ip":"203.0.113.9"}', true);
  set local role anon;
  if not public.check_invite(inv_code) then raise exception 'FAIL: lock did not expire'; end if;

  -- Expired and revoked codes look exactly like unknown ones.
  reset role;
  update public.invites set expires_at = now() - interval '1 second' where code = inv_code;
  set local role anon;
  perform set_config('request.headers', '{"x-real-ip":"203.0.113.11"}', true);
  if public.check_invite(inv_code) then raise exception 'FAIL: expired invite accepted'; end if;
  reset role;
  perform set_config('request.headers', '', true);

  ------------------------------------------------------------------ signup with a good invite
  perform set_config('request.jwt.claims', '', true);
  update public.invites set expires_at = now() + interval '1 day' where code = inv_code;
  insert into auth.users (id, email, aud, role, raw_user_meta_data)
  values (v_new, 'new@example.invalid', 'authenticated', 'authenticated', jsonb_build_object('invite_code', inv_code));
  select count(*) into n from public.profiles where id = v_new and status = 'pending' and tier_id = t_recruit and not setup_complete;
  if n <> 1 then raise exception 'FAIL: signup profile wrong'; end if;
  select count(*) into n from public.invites where code = inv_code and used_by = v_new and used_at is not null;
  if n <> 1 then raise exception 'FAIL: invite not marked used'; end if;

  -- Second user for the cross-user checks.
  insert into public.invites (code, tier_id) values ('fakeinvite0000000003', t_contractor);
  insert into auth.users (id, email, aud, role, raw_user_meta_data)
  values (v_other, 'other@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"FAKEINVITE-0000000003"}');
  select count(*) into n from public.profiles where id = v_other and tier_id = t_contractor;
  if n <> 1 then raise exception 'FAIL: contractor invite did not carry its tier'; end if;

  ------------------------------------------------------------------ account setup
  perform set_config('request.jwt.claims', json_build_object('sub', v_new, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- Pending user: no private data of anyone, no roster, but own profile is readable.
  select count(*) into n from public.member_private; if n <> 0 then raise exception 'FAIL: pending read member_private'; end if;

  -- Validation (fixed error codes, no values echoed).
  begin
    perform public.complete_setup('x', 'Fake Name', date '1990-01-01', null, 'None', 'Fake Contact', 'Friend', '555 010 0100');
    raise exception 'FAIL: 1-char callsign accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_callsign' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin
    perform public.complete_setup('FAKE-ONE!', 'Fake Name', date '1990-01-01', null, 'None', 'Fake Contact', 'Friend', '555 010 0100');
    raise exception 'FAIL: bad callsign chars accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform public.complete_setup('FAKE-ONE', 'Fake Name', current_date + 1, null, 'None', 'Fake Contact', 'Friend', '555 010 0100');
    raise exception 'FAIL: future DOB accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_dob' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin
    perform public.complete_setup('FAKE-ONE', 'Fake Name', date '1990-01-01', null, '  ', 'Fake Contact', 'Friend', '555 010 0100');
    raise exception 'FAIL: blank allergies accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform public.complete_setup('FAKE-ONE', 'Fake Name', date '1990-01-01', null, 'None', 'Fake Contact', 'Friend', 'abc');
    raise exception 'FAIL: bad emergency phone accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform public.complete_setup('FAKE-ONE', 'Fake Name', date '1990-01-01', 'nope', 'None', 'Fake Contact', 'Friend', '555 010 0100');
    raise exception 'FAIL: bad phone accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform public.complete_setup('FAKE-ONE', 'Fake Name', date '1990-01-01', null, 'None', 'Fake Contact', '', '555 010 0100');
    raise exception 'FAIL: missing relationship accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  select count(*) into n from public.profiles where id = v_new and not setup_complete;
  if n <> 1 then raise exception 'FAIL: failed setup changed the profile'; end if;

  -- A client cannot flip the flag directly.
  begin
    update public.profiles set setup_complete = true where id = v_new;
    raise exception 'FAIL: client set setup_complete';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  perform public.complete_setup('Fake-One', 'Fake Legal Name', date '1990-01-01', null, 'None', 'Fake Contact', 'Friend', '555 010 0100');

  select count(*) into n from public.profiles where id = v_new and setup_complete and callsign = 'Fake-One';
  if n <> 1 then raise exception 'FAIL: setup did not complete'; end if;
  select count(*) into n from public.member_private where profile_id = v_new and phone is null and allergies = 'None';
  if n <> 1 then raise exception 'FAIL: own private row not readable/correct'; end if;

  begin
    perform public.complete_setup('Fake-One', 'Fake Legal Name', date '1990-01-01', null, 'None', 'Fake Contact', 'Friend', '555 010 0100');
    raise exception 'FAIL: setup ran twice';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Owner can correct their own row.
  update public.member_private set phone = '555 010 0199' where profile_id = v_new;

  -- Owner cannot write someone else's row, nor insert a row for someone else.
  update public.member_private set phone = '555 010 0000' where profile_id <> v_new;
  begin
    insert into public.member_private
      (profile_id, legal_name, dob, allergies, emergency_name, emergency_relationship, emergency_phone)
    values (v_mem, 'Fake', date '1990-01-01', 'None', 'Fake', 'Friend', '555 010 0100');
    raise exception 'FAIL: wrote private data for another profile';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Callsign taken (case-insensitive) is reported with the fixed code.
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.complete_setup('FAKE-ONE', 'Fake Other', date '1991-02-03', null, 'None', 'Fake Contact', 'Friend', '555 010 0101');
    raise exception 'FAIL: duplicate callsign accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'callsign_taken' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.complete_setup('Fake-Two', 'Fake Other', date '1991-02-03', '555 010 0102', 'Fake allergy', 'Fake Contact', 'Sibling', '555 010 0101');

  -- Other user cannot see the first user's private row.
  select count(*) into n from public.member_private where profile_id = v_new;
  if n <> 0 then raise exception 'FAIL: user read another user''s private row'; end if;

  ------------------------------------------------------------------ plain Member cannot read private rows
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.member_private; if n <> 0 then raise exception 'FAIL: member read private rows'; end if;
  begin
    perform public.approve_member(v_new);
    raise exception 'FAIL: member approved an account';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ Command reads, approves, rejects
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.member_private; if n <> 2 then raise exception 'FAIL: command should read 2 private rows (got %)', n; end if;

  -- Command cannot edit another member's private row.
  update public.member_private set phone = '555 010 0000' where profile_id = v_new;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: command edited another member''s private row'; end if;

  perform public.approve_member(v_new);
  select count(*) into n from public.profiles where id = v_new and status = 'approved' and tier_id = t_recruit;
  if n <> 1 then raise exception 'FAIL: approve did not keep the invited tier'; end if;
  select count(*) into n from public.profile_audit
    where profile_id = v_new and event = 'status' and new_value = 'approved' and actor_id = v_cmd;
  if n <> 1 then raise exception 'FAIL: approval not audited'; end if;

  begin
    perform public.approve_member(v_new);
    raise exception 'FAIL: approved an already approved account';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  perform public.reject_member(v_other);
  select count(*) into n from public.profiles where id = v_other and status = 'suspended';
  if n <> 1 then raise exception 'FAIL: reject did not suspend'; end if;

  -- Approving needs completed setup.
  reset role;
  perform set_config('request.jwt.claims', '', true);
  insert into public.invites (code, tier_id) values ('fakeinvite0000000004', t_recruit);
  insert into auth.users (id, email, aud, role, raw_user_meta_data)
  values (v_new2, 'new2@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"fakeinvite0000000004"}');
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.approve_member(v_new2);
    raise exception 'FAIL: approved an account that skipped setup';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Suspended users cannot run setup.
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.complete_setup('Fake-Three', 'Fake', date '1990-01-01', null, 'None', 'Fake', 'Friend', '555 010 0100');
    raise exception 'FAIL: suspended user ran setup';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ audit of private writes: names only
  reset role;
  perform set_config('request.jwt.claims', '', true);
  select count(*) into n from public.profile_audit where event = 'private' and profile_id = v_new;
  if n < 2 then raise exception 'FAIL: private writes not audited (got %)', n; end if;
  select count(*) into n from public.profile_audit
    where event = 'private'
      and (coalesce(new_value, '') ~* 'Fake Legal|1990|555|Fake allergy|Fake Contact'
        or coalesce(old_value, '') <> '');
  if n <> 0 then raise exception 'FAIL: audit log contains private values'; end if;
  select count(*) into n from public.profile_audit
    where event = 'private' and profile_id = v_new and new_value like '%allergies%' and new_value like '%dob%' and actor_id = v_new;
  if n < 1 then raise exception 'FAIL: audit should name the fields written by the owner'; end if;
  select count(*) into n from public.profile_audit where event = 'private' and new_value = 'phone' and actor_id = v_new;
  if n <> 1 then raise exception 'FAIL: phone-only edit should log just the field name'; end if;

  ------------------------------------------------------------------ delete: admins only
  perform set_config('request.jwt.claims', json_build_object('sub', v_new, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.member_private where profile_id = v_new;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: non-admin deleted private data'; end if;
  reset role;

  ------------------------------------------------------------------ seed
  select count(*) into n from public.tier_capabilities tc join public.tiers t on t.id = tc.tier_id
    where tc.capability_key = 'view_member_private' and t.name = 'Command';
  if n <> 1 then raise exception 'FAIL: Command should hold view_member_private'; end if;
  select count(*) into n from public.tier_capabilities where capability_key = 'view_member_private';
  if n <> 1 then raise exception 'FAIL: only Command should hold view_member_private'; end if;

  raise notice 'invites_private: ALL PASS';
end;
$$;

rollback;
