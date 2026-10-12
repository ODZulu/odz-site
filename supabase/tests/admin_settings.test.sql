-- Tier 1 database tests for MVA-141: admin settings (invites shown once, tier and capability
-- management with guards, audit feed, my_capabilities). Plain SQL, one rolled-back transaction,
-- fake users and values only. Run against a dev or branch database, never one holding real members.
-- Any failure raises an exception.

begin;

do $$
declare
  v_admin  uuid := '00000000-0000-0000-0000-0000000000a1';
  v_cmd    uuid := '00000000-0000-0000-0000-0000000000c1';
  v_mem    uuid := '00000000-0000-0000-0000-0000000000b1';
  v_pend   uuid := '00000000-0000-0000-0000-0000000000d1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid; t_contractor uuid; t_new uuid; t_extra uuid;
  inv_code text;
  n integer;
  caps text[];
  ids uuid[];
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';
  select id into t_contractor from public.tiers where name = 'Contractor';

  -- Fixtures (trusted): an admin, a Command member, a Member, a pending account.
  insert into public.invites (code, tier_id)
  select 'adminfake000000000' || g, t_recruit from generate_series(1, 4) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_admin, 'admin@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"adminfake0000000001"}'),
    (v_cmd,   'cmd@example.invalid',   'authenticated', 'authenticated', '{"invite_code":"adminfake0000000002"}'),
    (v_mem,   'mem@example.invalid',   'authenticated', 'authenticated', '{"invite_code":"adminfake0000000003"}'),
    (v_pend,  'pend@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"adminfake0000000004"}');
  update public.profiles set status = 'approved', is_admin = true, setup_complete = true, callsign = 'Fake-Admin' where id = v_admin;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;

  ------------------------------------------------------------------ invites: shown once
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;

  inv_code := public.create_invite(t_recruit, 'fake for list', 7);
  if length(inv_code) < 10 then raise exception 'FAIL: short code'; end if;

  begin
    perform code from public.invites;
    raise exception 'FAIL: command could read invite codes again';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform * from public.invites;
    raise exception 'FAIL: select * on invites exposed the code';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  select count(*) into n from public.list_invites() l
    where l.code_hint = right(inv_code, 4) and l.status = 'active' and l.note = 'fake for list'
      and l.tier = 'Recruit' and l.created_by = 'Fake-Cmd';
  if n <> 1 then raise exception 'FAIL: list_invites row wrong (got %)', n; end if;
  select count(*) into n from public.list_invites() l where l.code_hint <> right(l.code_hint, 4);
  if n <> 0 then raise exception 'FAIL: list_invites exposes more than 4 characters'; end if;

  begin perform public.create_invite(t_recruit, null, 0); raise exception 'FAIL: 0 days accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.create_invite(t_recruit, null, 31); raise exception 'FAIL: 31 days accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  perform public.create_invite(t_contractor, null, 30);
  perform public.create_invite(t_recruit, null, 1);

  begin
    insert into public.invites (tier_id) values (t_recruit);
    raise exception 'FAIL: direct invite insert allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Revoke (direct update of revoked_at is still the way), then it reports as revoked.
  update public.invites set revoked_at = now() where note = 'fake for list';
  select count(*) into n from public.list_invites() l where l.note = 'fake for list' and l.status = 'revoked';
  if n <> 1 then raise exception 'FAIL: revoked status wrong'; end if;

  -- Used and expired statuses.
  reset role;
  update public.invites set expires_at = now() - interval '1 minute' where code = 'adminfake0000000099' or note is null and tier_id = t_recruit and created_by = v_cmd;
  set local role authenticated;
  select count(*) into n from public.list_invites() l where l.status = 'expired';
  if n < 1 then raise exception 'FAIL: expired status not shown'; end if;
  select count(*) into n from public.list_invites() l where l.status = 'used';
  if n <> 4 then raise exception 'FAIL: used invites should report as used (got %)', n; end if;
  select count(*) into n from public.list_invites() l where l.status = 'used' and l.used_by = 'Fake-Admin';
  if n <> 1 then raise exception 'FAIL: used invites should show who used them (got %)', n; end if;

  -- A Member cannot list or create.
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.list_invites(); raise exception 'FAIL: member listed invites';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.create_invite(); raise exception 'FAIL: member created an invite';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ tiers: admin only, with guards
  -- Command is not an admin: all tier RPCs refuse.
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.create_tier('Fake Tier'); raise exception 'FAIL: command created a tier';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.set_tier_capability(t_mem, 'write_events', true); raise exception 'FAIL: command changed capabilities';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- Direct writes are closed even for admins.
  begin update public.tiers set name = 'Hacked' where id = t_mem; raise exception 'FAIL: direct tier update allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.tier_capabilities (tier_id, capability_key) values (t_mem, 'write_events'); raise exception 'FAIL: direct capability insert allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  t_new := public.create_tier('  Fake Tier  ');
  select count(*) into n from public.tiers where id = t_new and name = 'Fake Tier' and rank = (select max(rank) from public.tiers);
  if n <> 1 then raise exception 'FAIL: new tier should be trimmed and last in rank'; end if;
  begin perform public.create_tier('Fake Tier'); raise exception 'FAIL: duplicate tier name accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'name_taken' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.create_tier('   '); raise exception 'FAIL: blank tier name accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  perform public.rename_tier(t_new, 'Fake Tier B');
  select count(*) into n from public.tiers where id = t_new and name = 'Fake Tier B';
  if n <> 1 then raise exception 'FAIL: rename failed'; end if;

  -- Reorder: must list every tier exactly once.
  select array_agg(id order by rank) into ids from public.tiers;
  begin perform public.reorder_tiers(ids[1:3]); raise exception 'FAIL: partial reorder accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  perform public.reorder_tiers(ids);
  -- Move the new tier to the front, then back.
  perform public.reorder_tiers(t_new || array(select x from unnest(ids) x where x <> t_new));
  select count(*) into n from public.tiers where id = t_new and rank = 1;
  if n <> 1 then raise exception 'FAIL: reorder did not move the tier'; end if;
  perform public.reorder_tiers(array(select x from unnest(ids) x where x <> t_new) || t_new);
  select count(*) into n from (select rank from public.tiers group by rank having count(*) > 1) d;
  if n <> 0 then raise exception 'FAIL: duplicate ranks after reorder'; end if;

  -- Delete: tiers with members, and tiers in the Command rules, are protected.
  begin perform public.delete_tier(t_mem); raise exception 'FAIL: deleted a tier with members';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'tier_has_members' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.delete_tier(t_og); raise exception 'FAIL: deleted the tier Command releases to';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'tier_in_rules' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.delete_tier(t_cmd); raise exception 'FAIL: deleted Command';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  perform public.delete_tier(t_new);
  select count(*) into n from public.tiers where id = t_new;
  if n <> 0 then raise exception 'FAIL: empty tier not deleted'; end if;

  ------------------------------------------------------------------ capabilities
  begin perform public.set_tier_capability(t_mem, 'view_member_private', true);
    raise exception 'FAIL: view_member_private changed without confirmation';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'confirmation_required' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.set_tier_capability(t_mem, 'view_member_private', true, 'private');
    raise exception 'FAIL: wrong-case confirmation accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  perform public.set_tier_capability(t_mem, 'view_member_private', true, 'PRIVATE');
  perform public.set_tier_capability(t_mem, 'view_member_private', false, 'PRIVATE');
  perform public.set_tier_capability(t_mem, 'write_events', true);

  -- Lockout guard: approve_members is held only by Command in the seed.
  begin perform public.set_tier_capability(t_cmd, 'approve_members', false);
    raise exception 'FAIL: approve_members removed from every tier';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'approve_members_lockout' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.set_tier_capability(t_mem, 'approve_members', true);
  perform public.set_tier_capability(t_cmd, 'approve_members', false);   -- fine: Member still holds it
  perform public.set_tier_capability(t_cmd, 'approve_members', true);
  perform public.set_tier_capability(t_mem, 'approve_members', false);
  begin perform public.set_tier_capability(t_mem, 'nonexistent_cap', true); raise exception 'FAIL: unknown capability accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Entry/release rules cannot be edited when called with a JWT (here as postgres, with a user's claims).
  reset role;
  begin
    update public.tiers set release_to_tier_id = null where id = t_cmd;
    raise exception 'FAIL: release rule cleared';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    update public.tiers set entry_requires_tier_id = t_mem where id = t_cmd;
    raise exception 'FAIL: entry rule changed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  -- A trusted caller (no JWT) can still migrate it.
  perform set_config('request.jwt.claims', '', true);
  update public.tiers set release_to_tier_id = t_og where id = t_cmd;

  ------------------------------------------------------------------ nobody changes their own tier
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin update public.profiles set tier_id = t_mem where id = v_admin; raise exception 'FAIL: admin changed own tier';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Admin sets another member's tier and status; entry rule still applies.
  update public.profiles set tier_id = t_contractor where id = v_mem;
  begin update public.profiles set tier_id = t_cmd where id = v_mem; raise exception 'FAIL: skipped Old Guard for Command';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  update public.profiles set tier_id = t_mem where id = v_mem;

  ------------------------------------------------------------------ my_capabilities
  select array_agg(c order by c) into caps from public.my_capabilities() c;
  if cardinality(caps) <> (select count(*) from public.capabilities) then raise exception 'FAIL: admin should hold every capability'; end if;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select array_agg(c order by c) into caps from public.my_capabilities() c;
  if not ('approve_members' = any(caps) and 'edit_roster' = any(caps) and 'view_member_private' = any(caps)) then
    raise exception 'FAIL: command capabilities wrong (%)', caps;
  end if;
  if 'nonsense' = any(caps) then raise exception 'FAIL'; end if;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pend, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.my_capabilities();
  if n <> 0 then raise exception 'FAIL: pending account has capabilities'; end if;

  ------------------------------------------------------------------ audit feed
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.list_audit(100, 0) a where a.kind = 'settings' and a.event = 'tier_created' and a.actor = 'Fake-Admin';
  if n <> 1 then raise exception 'FAIL: tier creation not in the feed (got %)', n; end if;
  select count(*) into n from public.list_audit(100, 0) a where a.event = 'tier_renamed' and a.detail = 'Fake Tier -> Fake Tier B';
  if n <> 1 then raise exception 'FAIL: rename not in the feed'; end if;
  select count(*) into n from public.list_audit(100, 0) a where a.event = 'capability_granted' and a.detail = 'view_member_private';
  if n <> 1 then raise exception 'FAIL: capability change not in the feed'; end if;
  select count(*) into n from public.list_audit(100, 0) a where a.kind = 'invite' and a.event = 'created';
  if n < 3 then raise exception 'FAIL: invite creation not in the feed'; end if;
  select count(*) into n from public.list_audit(100, 0) a where a.kind = 'profile' and a.event = 'tier';
  if n < 1 then raise exception 'FAIL: tier change not in the feed'; end if;

  -- Pagination and total.
  select count(*) into n from public.list_audit(2, 0);
  if n <> 2 then raise exception 'FAIL: limit ignored'; end if;
  select max(a.total) into n from public.list_audit(2, 0) a;
  if n < 5 then raise exception 'FAIL: total missing'; end if;
  select count(*) into n from public.list_audit(2, 1000);
  if n <> 0 then raise exception 'FAIL: offset past the end should be empty'; end if;

  -- Private values never appear in the feed text.
  reset role;
  perform set_config('request.jwt.claims', '', true);
  insert into public.member_private (profile_id, legal_name, dob, allergies, emergency_name, emergency_relationship, emergency_phone)
  values (v_mem, 'Fake Legal Value', date '1991-02-03', 'Fake Allergy Value', 'Fake Contact Value', 'Friend', '555-010-0100');
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.list_audit(100, 0) a
    where a.event = 'private' and a.detail like 'fields: %' and a.detail !~* 'Fake|1991|555';
  if n <> 1 then raise exception 'FAIL: private write should appear as field names only'; end if;
  select count(*) into n from public.list_audit(100, 0) a where a.detail ~* 'Fake Legal|Fake Allergy|Fake Contact|1991|555';
  if n <> 0 then raise exception 'FAIL: private values leaked into the audit feed'; end if;

  -- A Member cannot read the feed or the settings audit table.
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.list_audit(); raise exception 'FAIL: member read the audit feed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  select count(*) into n from public.settings_audit; if n <> 0 then raise exception 'FAIL: member read settings_audit'; end if;

  -- Anon can call nothing here.
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform public.list_audit(); raise exception 'FAIL: anon read the audit feed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.create_invite(); raise exception 'FAIL: anon created an invite';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.my_capabilities(); raise exception 'FAIL: anon called my_capabilities';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  raise notice 'admin_settings: ALL PASS';
end;
$$;

rollback;
