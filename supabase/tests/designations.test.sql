-- Tier 1 database tests for MVA-220: designations (catalog, assign/revoke, capability union,
-- Command's automatic inheritance, eligibility, holder caps, audit, RLS).
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_adm  uuid := '00000000-0000-0000-0000-0000000000f1'; -- Admin
  v_cmd  uuid := '00000000-0000-0000-0000-0000000000f2'; -- Command
  v_og1  uuid := '00000000-0000-0000-0000-0000000000f3'; -- Old Guard, gets Treasurer
  v_og2  uuid := '00000000-0000-0000-0000-0000000000f4'; -- Old Guard, second seat attempt
  v_mem  uuid := '00000000-0000-0000-0000-0000000000f5'; -- Member, not eligible for office seats
  v_sup  uuid := '00000000-0000-0000-0000-0000000000f6'; -- Support, eligible for Shop Manager
  t_cmd uuid; t_og uuid; t_mem uuid; t_sup uuid; t_recruit uuid;
  d_treasurer uuid; d_quartermaster uuid; d_shop uuid; d_xo uuid; d_training uuid;
  n integer;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_sup from public.tiers where name = 'Support';
  select id into t_recruit from public.tiers where name = 'Recruit';

  ------------------------------------------------------------------ seed catalog
  select count(*) into n from public.designations;
  if n <> 5 then raise exception 'FAIL: expected 5 seeded designations (got %)', n; end if;
  select id into d_treasurer from public.designations where name = 'Treasurer';
  select id into d_quartermaster from public.designations where name = 'Quartermaster';
  select id into d_shop from public.designations where name = 'Shop Manager';
  select id into d_xo from public.designations where name = 'XO';
  select id into d_training from public.designations where name = 'Training Officer';
  if d_treasurer is null or d_quartermaster is null or d_shop is null or d_xo is null or d_training is null then
    raise exception 'FAIL: missing a seeded designation (amendment: XO and Training Officer)';
  end if;
  select count(*) into n from public.designations where office_seat and max_holders = 1
    and name in ('Treasurer', 'Quartermaster', 'XO', 'Training Officer');
  if n <> 4 then raise exception 'FAIL: office seats should be Treasurer, Quartermaster, XO, Training Officer (got %)', n; end if;
  select count(*) into n from public.designations where name = 'Shop Manager' and not office_seat and max_holders = 1;
  if n <> 1 then raise exception 'FAIL: Shop Manager should be open to any tier, one holder'; end if;
  select count(*) into n from public.designations d join public.capabilities c on c.key = d.capability_key;
  if n <> 5 then raise exception 'FAIL: every designation capability should exist in the catalog'; end if;

  ------------------------------------------------------------------ seed fake accounts
  insert into public.invites (code, tier_id)
  select 'desfake0000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 15) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm, 'des-adm@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"desfake000000010"}'),
    (v_cmd, 'des-cmd@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"desfake000000011"}'),
    (v_og1, 'des-og1@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"desfake000000012"}'),
    (v_og2, 'des-og2@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"desfake000000013"}'),
    (v_mem, 'des-mem@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"desfake000000014"}'),
    (v_sup, 'des-sup@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"desfake000000015"}');
  update public.profiles set status = 'approved', is_admin = true, setup_complete = true, callsign = 'Fake-Des-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Des-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Des-Og1' where id = v_og1;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Des-Og2' where id = v_og2;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Des-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_sup, setup_complete = true, callsign = 'Fake-Des-Sup' where id = v_sup;

  ------------------------------------------------------------------ Command inherits every designation capability, unassigned
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if not public.has_capability('manage_treasury') then raise exception 'FAIL: Command should inherit manage_treasury unassigned'; end if;
  if not public.has_capability('manage_inventory') then raise exception 'FAIL: Command should inherit manage_inventory unassigned'; end if;
  if not public.has_capability('manage_shop') then raise exception 'FAIL: Command should inherit manage_shop unassigned'; end if;
  if not public.has_capability('hold_office_xo') then raise exception 'FAIL: Command should inherit hold_office_xo unassigned'; end if;
  if not public.has_capability('hold_office_training') then raise exception 'FAIL: Command should inherit hold_office_training unassigned'; end if;
  reset role;

  -- An Old Guard member with no assignment does not inherit it.
  perform set_config('request.jwt.claims', json_build_object('sub', v_og1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.has_capability('manage_treasury') then raise exception 'FAIL: Old Guard should not inherit designation capabilities'; end if;
  reset role;

  -- Leaving Command (the release rule sends it to Old Guard) removes the inherited capability at
  -- once. An actor other than the target makes the change: nobody may change their own tier.
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set tier_id = t_mem where id = v_cmd;
  reset role;
  select count(*) into n from public.profiles where id = v_cmd and tier_id = t_og;
  if n <> 1 then raise exception 'FAIL: leaving Command should release to Old Guard, not land on Member'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.has_capability('manage_treasury') then raise exception 'FAIL: leaving Command should remove the inherited capability at once'; end if;
  reset role;
  -- Put it back for the assign-authority checks below (edit_roster is Command's default capability).
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  reset role;

  ------------------------------------------------------------------ who may assign/revoke
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.assign_designation(v_og1, d_treasurer); raise exception 'FAIL: a plain Member assigned a designation';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_og1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.assign_designation(v_og1, d_treasurer); raise exception 'FAIL: Old Guard without edit_roster self-assigned';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform public.assign_designation(v_og1, d_treasurer); raise exception 'FAIL: anon assigned a designation';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ eligibility: office seats need Old Guard or Command
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.assign_designation(v_mem, d_treasurer); raise exception 'FAIL: a Member was assigned an office seat';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_eligible_tier' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;

  -- Shop Manager (not an office seat) is open to any tier, Support included.
  perform public.assign_designation(v_sup, d_shop);
  reset role;
  select count(*) into n from public.member_designations where profile_id = v_sup and designation_id = d_shop;
  if n <> 1 then raise exception 'FAIL: Shop Manager should be assignable to Support'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if not public.has_capability('manage_shop') then raise exception 'FAIL: Support holding Shop Manager should have manage_shop'; end if;
  if public.has_capability('edit_roster') then raise exception 'FAIL: Shop Manager should grant only manage_shop'; end if;
  reset role;

  ------------------------------------------------------------------ assign to an eligible Old Guard member; capability union
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.assign_designation(v_og1, d_treasurer);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_og1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if not public.has_capability('manage_treasury') then raise exception 'FAIL: assigned Treasurer should have manage_treasury'; end if;
  select count(*) into n from public.my_capabilities() c where c = 'manage_treasury';
  if n <> 1 then raise exception 'FAIL: my_capabilities() should list manage_treasury for the assigned holder'; end if;
  reset role;

  -- One person may hold more than one seat (Dax ruling).
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.assign_designation(v_og1, d_quartermaster);
  reset role;
  select count(*) into n from public.member_designations where profile_id = v_og1;
  if n <> 2 then raise exception 'FAIL: one person should be able to hold two office seats (got %)', n; end if;

  ------------------------------------------------------------------ holder cap and duplicate assignment
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.assign_designation(v_og2, d_treasurer); raise exception 'FAIL: Treasurer exceeded its holder cap';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'designation_full' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.assign_designation(v_og1, d_treasurer); raise exception 'FAIL: double-assigned the same designation';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'already_assigned' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.revoke_designation(v_og2, d_treasurer); raise exception 'FAIL: revoked a designation nobody held';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_assigned' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  ------------------------------------------------------------------ revoke drops the capability at once
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.revoke_designation(v_og1, d_treasurer);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_og1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.has_capability('manage_treasury') then raise exception 'FAIL: revoke should drop manage_treasury at once'; end if;
  if not public.has_capability('manage_inventory') then raise exception 'FAIL: revoking one seat should not touch the other'; end if;
  reset role;
  -- The freed seat can be assigned to someone else.
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.assign_designation(v_og2, d_treasurer);
  reset role;

  ------------------------------------------------------------------ audit log (who, whom, designation, when)
  select count(*) into n from public.designation_audit where callsign = 'Fake-Des-Og1' and designation_name = 'Treasurer' and action = 'assigned' and actor_id = v_cmd;
  if n <> 1 then raise exception 'FAIL: assign not logged with actor, whom and designation'; end if;
  select count(*) into n from public.designation_audit where callsign = 'Fake-Des-Og1' and designation_name = 'Treasurer' and action = 'revoked' and actor_id = v_cmd;
  if n <> 1 then raise exception 'FAIL: revoke not logged with actor, whom and designation'; end if;

  ------------------------------------------------------------------ designation_holders excludes soft-removed members
  select count(*) into n from public.designation_holders(d_quartermaster) where profile_id = v_og1;
  if n <> 1 then raise exception 'FAIL: designation_holders should list the current holder'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.remove_member(v_og1, 'Fake removal for designation_holders check');
  reset role;
  select count(*) into n from public.designation_holders(d_quartermaster);
  if n <> 0 then raise exception 'FAIL: designation_holders should exclude a soft-removed member (got %)', n; end if;

  ------------------------------------------------------------------ overview / Vacant: Admin, edit_roster, or any seat holder
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.designations_overview(); raise exception 'FAIL: a plain Member read the designations overview';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_og2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.designations_overview() where name = 'XO' and holder_count = 0;
  if n <> 1 then raise exception 'FAIL: Old Guard (seat holder) should see XO as vacant'; end if;
  select count(*) into n from public.designations_overview() where name = 'Treasurer' and holder_count = 1;
  if n <> 1 then raise exception 'FAIL: overview holder_count for Treasurer should be 1 after the reassignment'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.designations_overview();
  reset role;

  ------------------------------------------------------------------ list_audit picks up designation events
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.list_audit(100, 0) where kind = 'designation' and event = 'assigned' and target = 'Fake-Des-Og2' and detail = 'Treasurer';
  if n <> 1 then raise exception 'FAIL: list_audit should show the designation assignment'; end if;
  reset role;

  ------------------------------------------------------------------ RLS: badges readable by any approved account, writes RPC-only
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.designations;
  if n <> 5 then raise exception 'FAIL: an approved member should read the designation catalog'; end if;
  select count(*) into n from public.member_designations;
  if n = 0 then raise exception 'FAIL: an approved member should read current assignments (badges)'; end if;
  begin insert into public.member_designations (profile_id, designation_id) values (v_mem, d_shop); raise exception 'FAIL: direct insert into member_designations allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin update public.designations set max_holders = 99 where id = d_shop; raise exception 'FAIL: direct catalog update allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  -- RLS filters rows rather than erroring: a plain Member's grant covers the table, but the
  -- approve_members/edit_roster policy leaves nothing visible.
  select count(*) into n from public.designation_audit;
  if n <> 0 then raise exception 'FAIL: a plain Member should see no designation audit rows directly (got %)', n; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform count(*) from public.designations; raise exception 'FAIL: anon read the designation catalog';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform count(*) from public.member_designations; raise exception 'FAIL: anon read member_designations';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  raise notice 'designations: ALL PASS';
end;
$$;

rollback;
