-- Tier 1 database tests for MVA-248: the password-change audit row.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_mem  uuid := '00000000-0000-0000-0000-0000000000e8';
  v_sup  uuid := '00000000-0000-0000-0000-0000000000e9';
  v_ret  uuid := '00000000-0000-0000-0000-0000000000f8';
  v_pend uuid := '00000000-0000-0000-0000-0000000000f9';
  v_cmd  uuid := '00000000-0000-0000-0000-0000000000f7';
  n integer;
begin
  insert into public.invites (code, tier_id)
  select 'pwdfake0000000' || to_char(g, 'FM00'), (select id from public.tiers where name = 'Recruit') from generate_series(10, 14) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_mem,  'pwd-mem@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"pwdfake000000010"}'),
    (v_sup,  'pwd-sup@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"pwdfake000000011"}'),
    (v_ret,  'pwd-ret@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"pwdfake000000012"}'),
    (v_pend, 'pwd-pend@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"pwdfake000000013"}'),
    (v_cmd,  'pwd-cmd@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"pwdfake000000014"}');
  update public.profiles set status = 'approved', tier_id = (select id from public.tiers where name = 'Member'), setup_complete = true, callsign = 'Fake-Pwd-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = (select id from public.tiers where name = 'Support'), setup_complete = true, callsign = 'Fake-Pwd-Sup' where id = v_sup;
  update public.profiles set status = 'approved', tier_id = (select id from public.tiers where name = 'Member'), setup_complete = true, callsign = 'Fake-Pwd-Ret' where id = v_ret;
  update public.profiles set status = 'retired' where id = v_ret;
  update public.profiles set setup_complete = true, callsign = 'Fake-Pwd-Pend' where id = v_pend;
  update public.profiles set status = 'approved', tier_id = (select id from public.tiers where name = 'Old Guard'), setup_complete = true, callsign = 'Fake-Pwd-Cmd' where id = v_cmd;
  update public.profiles set tier_id = (select id from public.tiers where name = 'Command') where id = v_cmd;

  -- Approved (any tier, Support included) and retired accounts can log a change.
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.log_password_change();
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.log_password_change();
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ret, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.log_password_change();
  reset role;

  select count(*) into n from public.profile_audit
   where event = 'password_changed' and profile_id = actor_id and profile_id in (v_mem, v_sup, v_ret)
     and old_value = 'password' and new_value = 'changed' and note is null;
  if n <> 3 then raise exception 'FAIL: expected three password audit rows with fixed placeholder values (got %)', n; end if;

  -- Pending accounts and anon cannot.
  perform set_config('request.jwt.claims', json_build_object('sub', v_pend, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.log_password_change(); raise exception 'FAIL: a pending account logged a password change';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform public.log_password_change(); raise exception 'FAIL: anon logged a password change';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- A suspended or removed account cannot either.
  update public.profiles set status = 'suspended' where id = v_mem;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.log_password_change(); raise exception 'FAIL: a suspended account logged a password change';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- The audit table cannot be written by a client directly.
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin insert into public.profile_audit (profile_id, event) values (v_sup, 'password_changed'); raise exception 'FAIL: direct audit insert allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- Command reads the event in the audit feed, with no value in the detail.
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.list_audit(100, 0) where event = 'password_changed' and target like 'Fake-Pwd-%' and detail = 'password -> changed';
  if n <> 3 then raise exception 'FAIL: password changes should show in the feed without values (got %)', n; end if;
  reset role;

  raise notice 'password change audit: ALL PASS';
end;
$$;

rollback;
