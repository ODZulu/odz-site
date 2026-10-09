-- Tier 1 database tests for MVA-198. Plain SQL, no extensions.
-- Run against a dev or branch database (SQL editor, psql, or MCP execute_sql).
-- Everything happens inside one transaction that is rolled back, and all users are fake.
-- Success: the notice "db_foundation: ALL PASS". Any failure raises an exception.

begin;

do $$
declare
  v_admin   uuid := '00000000-0000-0000-0000-0000000000a1';
  v_admin2  uuid := '00000000-0000-0000-0000-0000000000a2';
  v_command uuid := '00000000-0000-0000-0000-0000000000c1';
  v_member  uuid := '00000000-0000-0000-0000-0000000000b1';
  v_pending uuid := '00000000-0000-0000-0000-0000000000d1';
  t_command uuid;
  t_member  uuid;
  n integer;
begin
  select id into t_command from public.tiers where name = 'Command';
  select id into t_member  from public.tiers where name = 'Member';

  -- Fake users; the signup trigger must give each a pending profile.
  insert into auth.users (id, email, aud, role) values
    (v_admin,   'admin@example.invalid',   'authenticated', 'authenticated'),
    (v_admin2,  'admin2@example.invalid',  'authenticated', 'authenticated'),
    (v_command, 'command@example.invalid', 'authenticated', 'authenticated'),
    (v_member,  'member@example.invalid',  'authenticated', 'authenticated'),
    (v_pending, 'pending@example.invalid', 'authenticated', 'authenticated');

  select count(*) into n from public.profiles where status = 'pending' and tier_id is null
    and id in (v_admin, v_admin2, v_command, v_member, v_pending);
  if n <> 5 then raise exception 'FAIL: signup trigger did not create 5 pending profiles (got %)', n; end if;

  -- Trusted setup (no JWT): one admin, a Command, a Member.
  update public.profiles set status = 'approved', is_admin = true where id = v_admin;
  update public.profiles set status = 'approved', tier_id = t_command where id = v_command;
  update public.profiles set status = 'approved', tier_id = t_member  where id = v_member;
  update public.profiles set callsign = 'FAKE-CMD' where id = v_command;

  ------------------------------------------------------------------ pending reads nothing
  perform set_config('request.jwt.claims', json_build_object('sub', v_pending, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.tiers;             if n <> 0 then raise exception 'FAIL: pending read tiers'; end if;
  select count(*) into n from public.capabilities;     if n <> 0 then raise exception 'FAIL: pending read capabilities'; end if;
  select count(*) into n from public.tier_capabilities; if n <> 0 then raise exception 'FAIL: pending read tier_capabilities'; end if;
  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'FAIL: pending should see only own profile (saw %)', n; end if;
  if public.has_capability('read_minutes') then raise exception 'FAIL: pending has read_minutes'; end if;

  begin
    update public.profiles set status = 'approved' where id = v_pending;
    raise exception 'FAIL: pending self-approved';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- A pending user may set their own callsign.
  update public.profiles set callsign = 'fake-pending', display_name = 'Fake Pending' where id = v_pending;

  ------------------------------------------------------------------ approved Member
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_member, 'role', 'authenticated')::text, true);
  set local role authenticated;

  if not public.has_capability('read_minutes') then raise exception 'FAIL: member lacks read_minutes'; end if;
  if not public.has_capability('read_event_details') then raise exception 'FAIL: member lacks read_event_details'; end if;
  if public.has_capability('write_minutes') then raise exception 'FAIL: member has write_minutes'; end if;
  if public.has_capability('write_events') then raise exception 'FAIL: member has write_events'; end if;
  if public.has_capability('approve_members') then raise exception 'FAIL: member has approve_members'; end if;

  select count(*) into n from public.tiers; if n <> 5 then raise exception 'FAIL: member should read 5 tiers (got %)', n; end if;

  -- Roster: approved profiles visible, pending ones not.
  select count(*) into n from public.profiles where status = 'pending';
  if n <> 0 then raise exception 'FAIL: member can see pending profiles'; end if;
  select count(*) into n from public.profiles where id = v_command;
  if n <> 1 then raise exception 'FAIL: member cannot see approved roster'; end if;

  -- Cannot self-promote by tier, admin flag, or status.
  begin
    update public.profiles set tier_id = t_command where id = v_member;
    raise exception 'FAIL: member self-promoted tier';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    update public.profiles set is_admin = true where id = v_member;
    raise exception 'FAIL: member self-granted admin';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    update public.profiles set status = 'suspended' where id = v_member;
    raise exception 'FAIL: member changed own status';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Cannot edit someone else's profile (RLS filters the row, so zero rows change).
  update public.profiles set display_name = 'tampered' where id = v_command;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: member edited another profile'; end if;

  -- Cannot write the config tables.
  begin
    insert into public.tiers (name, rank) values ('Rogue', 99);
    raise exception 'FAIL: member inserted a tier';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    insert into public.tier_capabilities (tier_id, capability_key) values (t_member, 'write_minutes');
    raise exception 'FAIL: member granted themselves a capability';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ Command
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_command, 'role', 'authenticated')::text, true);
  set local role authenticated;

  if not public.has_capability('write_minutes') then raise exception 'FAIL: command lacks write_minutes'; end if;
  if not public.has_capability('write_events') then raise exception 'FAIL: command lacks write_events'; end if;
  if not public.has_capability('approve_members') then raise exception 'FAIL: command lacks approve_members'; end if;

  -- Command sees the pending queue and can approve.
  select count(*) into n from public.profiles where id = v_pending;
  if n <> 1 then raise exception 'FAIL: command cannot see pending profile'; end if;
  update public.profiles set status = 'approved', tier_id = t_member where id = v_pending;

  -- Command cannot change own tier/status, cannot touch an admin, cannot grant admin.
  begin
    update public.profiles set tier_id = t_member where id = v_command;
    raise exception 'FAIL: command changed own tier';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    update public.profiles set status = 'suspended' where id = v_admin;
    raise exception 'FAIL: command suspended an admin';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    update public.profiles set is_admin = true where id = v_member;
    raise exception 'FAIL: command granted admin';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  -- Command cannot write the config tables either (admin only).
  begin
    insert into public.tiers (name, rank) values ('Rogue', 99);
    raise exception 'FAIL: command inserted a tier';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ Admin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  if not public.has_capability('write_minutes') then raise exception 'FAIL: admin lacks write_minutes'; end if;
  insert into public.capabilities (key, description) values ('test_cap', 'fake');
  insert into public.tier_capabilities (tier_id, capability_key) values (t_member, 'test_cap');
  delete from public.tier_capabilities where capability_key = 'test_cap';
  delete from public.capabilities where key = 'test_cap';

  -- Sole admin cannot demote or suspend themselves.
  begin
    update public.profiles set is_admin = false where id = v_admin;
    raise exception 'FAIL: last admin demoted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    update public.profiles set status = 'suspended' where id = v_admin;
    raise exception 'FAIL: last admin suspended';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ last-admin guard, any caller
  reset role;
  begin
    delete from auth.users where id = v_admin;
    raise exception 'FAIL: last admin deleted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    update public.profiles set is_admin = false where id = v_admin;
    raise exception 'FAIL: last admin demoted by trusted caller';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- With a second approved admin, demoting the first is allowed.
  update public.profiles set status = 'approved', is_admin = true where id = v_admin2;
  update public.profiles set is_admin = false where id = v_admin;

  ------------------------------------------------------------------ anon gets nothing
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin
    perform 1 from public.profiles;
    raise exception 'FAIL: anon read profiles';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform 1 from public.tiers;
    raise exception 'FAIL: anon read tiers';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ seed
  select count(*) into n from public.tiers;
  if n <> 5 then raise exception 'FAIL: expected 5 seeded tiers (got %)', n; end if;
  select count(*) into n from public.tier_capabilities where capability_key = 'read_minutes';
  if n <> 5 then raise exception 'FAIL: every tier should read minutes'; end if;
  select count(*) into n from public.tier_capabilities tc join public.tiers t on t.id = tc.tier_id
    where t.name = 'Command' and tc.capability_key in ('approve_members', 'write_minutes', 'write_events');
  if n <> 3 then raise exception 'FAIL: Command seed capabilities wrong'; end if;
  select count(*) into n from public.tier_capabilities where capability_key in ('approve_members', 'write_minutes', 'write_events');
  if n <> 3 then raise exception 'FAIL: only Command should hold write/approve capabilities'; end if;

  raise notice 'db_foundation: ALL PASS';
end;
$$;

rollback;
