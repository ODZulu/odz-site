-- Tier 1 database tests for MVA-237: the Support tier (role-based, no capabilities, excluded from
-- player counts, moves across the player/Support line are Command-only and noted).
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_adm  uuid := '00000000-0000-0000-0000-0000000000a1';
  v_cmd  uuid := '00000000-0000-0000-0000-0000000000c1';
  v_og   uuid := '00000000-0000-0000-0000-0000000000c2';
  v_mem  uuid := '00000000-0000-0000-0000-0000000000b1';
  v_mem2 uuid := '00000000-0000-0000-0000-0000000000b2';
  v_sup  uuid := '00000000-0000-0000-0000-0000000000e1';
  v_sup2 uuid := '00000000-0000-0000-0000-0000000000e2';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid; t_sup uuid; t_prospect uuid;
  e1 uuid;
  n integer;
  s boolean;
  code text;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';
  select id into t_prospect from public.tiers where name = 'Prospect';
  select id into t_sup from public.tiers where name = 'Support';

  ------------------------------------------------------------------ seed
  select count(*) into n from public.tiers where name = 'Support' and role_based and invitable and not counts_for_readiness and not is_default_for_approval;
  if n <> 1 then raise exception 'FAIL: Support tier not seeded as role-based, invitable, not counted'; end if;
  select count(*) into n from public.tiers where role_based;
  if n <> 1 then raise exception 'FAIL: only Support should be role-based (got %)', n; end if;
  select count(*) into n from public.tier_capabilities where tier_id = t_sup;
  if n <> 0 then raise exception 'FAIL: Support must start with no capabilities (got %)', n; end if;
  select count(*) into n from public.tiers where support_barred and name in ('Command', 'Old Guard');
  if n <> 2 then raise exception 'FAIL: Command and Old Guard should be barred from Support moves'; end if;
  select count(*) into n from public.tiers where support_barred;
  if n <> 2 then raise exception 'FAIL: only Command and Old Guard should be barred (got %)', n; end if;

  ------------------------------------------------------------------ invites
  insert into public.invites (note) values ('fake default');
  select count(*) into n from public.invites where note = 'fake default' and tier_id = t_recruit;
  if n <> 1 then raise exception 'FAIL: an invite with no tier should still default to Recruit'; end if;
  insert into public.invites (code, tier_id) values ('supfake000000001', t_sup), ('supfake000000002', t_sup);
  insert into public.invites (code, tier_id)
  select 'supfake00000000' || g, t_recruit from generate_series(3, 8) g;

  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm,  'adm@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"supfake000000003"}'),
    (v_cmd,  'cmd@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"supfake000000004"}'),
    (v_og,   'og@example.invalid',   'authenticated', 'authenticated', '{"invite_code":"supfake000000005"}'),
    (v_mem,  'mem@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"supfake000000006"}'),
    (v_mem2, 'mem2@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"supfake000000007"}'),
    (v_sup,  'sup@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"supfake000000001"}'),
    (v_sup2, 'sup2@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"supfake000000002"}');
  select tier_id = t_sup into s from public.profiles where id = v_sup;
  if s is not true then raise exception 'FAIL: signing up with a Support invite should give the Support tier'; end if;

  update public.profiles set status = 'approved', is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-OG' where id = v_og;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem2' where id = v_mem2;
  insert into public.member_private (profile_id, legal_name, dob, allergies, emergency_name, emergency_relationship, emergency_phone)
  values (v_mem, 'Fake Legal Name', date '1990-01-02', 'None', 'Fake Contact', 'Friend', '555-010-0100'),
         (v_mem2, 'Fake Legal Two', date '1990-01-03', 'None', 'Fake Contact', 'Friend', '555-010-0101');

  insert into public.events (title, starts_at) values ('Fake event', now() + interval '2 days') returning id into e1;
  insert into public.event_details (event_id, location_name, description) values (e1, 'Fake place', 'Fake description');
  insert into public.traffic (title, body) values ('Fake post', 'Fake body');
  insert into public.minutes (title, meeting_date) values ('Fake minutes', current_date);
  insert into public.event_rsvps (event_id, profile_id, response) values (e1, v_mem, 'in');

  ------------------------------------------------------------------ setup: callsign only
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if not public.my_tier_is_role_based() then raise exception 'FAIL: my_tier_is_role_based false for Support'; end if;
  begin perform public.complete_support_setup('x'); raise exception 'FAIL: 1-character callsign accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_callsign' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.complete_support_setup('fake-mem'); raise exception 'FAIL: duplicate callsign accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'callsign_taken' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.complete_support_setup('  Fake-Sup ');
  begin perform public.complete_support_setup('Fake-Sup-Again'); raise exception 'FAIL: setup ran twice';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'setup_already_complete' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select count(*) into n from public.profiles where id = v_sup and callsign = 'Fake-Sup' and setup_complete;
  if n <> 1 then raise exception 'FAIL: Support setup did not store the callsign'; end if;
  select count(*) into n from public.member_private where profile_id = v_sup;
  if n <> 0 then raise exception 'FAIL: Support setup created private details'; end if;

  -- A player cannot use the callsign-only path.
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.my_tier_is_role_based() then raise exception 'FAIL: my_tier_is_role_based true for a Member'; end if;
  begin perform public.complete_support_setup('Fake-Nope'); raise exception 'FAIL: a Member used the Support setup';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- Approval needs a completed setup, and Support approval keeps the Support tier.
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.approve_member(v_sup2); raise exception 'FAIL: approved a Support account that has not done setup';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  perform public.approve_member(v_sup);
  reset role;
  select count(*) into n from public.profiles where id = v_sup and status = 'approved' and tier_id = t_sup;
  if n <> 1 then raise exception 'FAIL: approval should keep the Support tier'; end if;

  ------------------------------------------------------------------ what an approved Support account can and cannot read
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.capabilities c where public.has_capability(c.key);
  if n <> 0 then raise exception 'FAIL: Support holds capabilities (got %)', n; end if;
  select count(*) into n from public.my_capabilities();
  if n <> 0 then raise exception 'FAIL: my_capabilities should be empty for Support (got %)', n; end if;

  select count(*) into n from public.traffic;
  if n <> 1 then raise exception 'FAIL: Support should read Traffic (got %)', n; end if;
  select count(*) into n from public.events;
  if n <> 1 then raise exception 'FAIL: Support should see the public events listing (got %)', n; end if;
  select count(*) into n from public.event_details;
  if n <> 0 then raise exception 'FAIL: Support read event location details'; end if;
  select count(*) into n from public.minutes;
  if n <> 0 then raise exception 'FAIL: Support read minutes'; end if;
  select count(*) into n from public.documents;
  if n <> 0 then raise exception 'FAIL: Support read documents'; end if;
  select count(*) into n from public.member_private;
  if n <> 0 then raise exception 'FAIL: Support read member private data (got %)', n; end if;
  select count(*) into n from public.event_rsvps;
  if n <> 0 then raise exception 'FAIL: Support read RSVPs'; end if;
  begin insert into public.event_rsvps (event_id, response) values (e1, 'in'); raise exception 'FAIL: Support RSVPed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform * from public.event_readiness(e1); raise exception 'FAIL: Support called event_readiness';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.traffic (title, body) values ('Fake', 'Fake'); raise exception 'FAIL: Support posted Traffic';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.create_invite(null, 'fake'); raise exception 'FAIL: Support created an invite';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.set_callsign(v_mem, 'Fake-Renamed'); raise exception 'FAIL: Support renamed a callsign';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Own profile edits work (display name, role note, bio) without any private details.
  perform public.update_own_profile('Fake Support', 'Gear', 'Fake bio');
  select count(*) into n from public.profiles where id = v_sup and display_name = 'Fake Support';
  if n <> 1 then raise exception 'FAIL: Support could not edit own profile'; end if;

  -- Not a way to promote themselves.
  begin update public.profiles set tier_id = t_mem where id = v_sup; exception when others then null; end;
  reset role;
  select count(*) into n from public.profiles where id = v_sup and tier_id = t_sup;
  if n <> 1 then raise exception 'FAIL: Support changed own tier'; end if;

  ------------------------------------------------------------------ counts exclude Support
  -- Command reads readiness: only the two Members count, and Support never adds to them.
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.event_readiness(e1) r where r.eligible = 4 and r.in_count = 1;
  if n <> 1 then raise exception 'FAIL: readiness should count Command, Old Guard and Member accounts only (Support is excluded)'; end if;
  select count(*) into n from public.tier_breakdown() b where b.tier_name = 'Support' and b.member_count = 1;
  if n <> 1 then raise exception 'FAIL: tier breakdown should list Support with its own count'; end if;
  reset role;

  ------------------------------------------------------------------ moves: who may call
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.move_support_tier(v_mem2, t_sup, 'Fake reason'); raise exception 'FAIL: Member moved a tier';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform public.move_support_tier(v_mem2, t_sup, 'Fake reason'); raise exception 'FAIL: anon moved a tier';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ moves: Command
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- Direct updates across the line are refused, even for Command.
  begin update public.profiles set tier_id = t_mem where id = v_sup; raise exception 'FAIL: direct Support -> Member update accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin update public.profiles set tier_id = t_sup where id = v_mem2; raise exception 'FAIL: direct Member -> Support update accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  select count(*) into n from public.profiles where (id = v_sup and tier_id = t_sup) or (id = v_mem2 and tier_id = t_mem);
  if n <> 2 then raise exception 'FAIL: a refused direct update still moved someone'; end if;

  -- Note rules, same-side moves, barred tiers, self.
  begin perform public.move_support_tier(v_mem2, t_sup, ''); raise exception 'FAIL: empty note accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_note' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.move_support_tier(v_mem2, t_sup, repeat('n', 301)); raise exception 'FAIL: 301-character note accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_note' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.move_support_tier(v_mem2, t_prospect, 'Fake note'); raise exception 'FAIL: a normal tier move went through the Support path';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_a_support_move' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.move_support_tier(v_sup, t_og, 'Fake note'); raise exception 'FAIL: Support moved straight to Old Guard';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'tier_barred' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.move_support_tier(v_sup, t_cmd, 'Fake note'); raise exception 'FAIL: Support moved straight to Command';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'tier_barred' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.move_support_tier(v_og, t_sup, 'Fake note'); raise exception 'FAIL: Old Guard moved straight to Support';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'tier_barred' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.move_support_tier(v_cmd, t_sup, 'Fake note'); raise exception 'FAIL: Command moved themselves to Support';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Player -> Support, logged with the note.
  perform public.move_support_tier(v_mem2, t_sup, '  Fake note: takes over gear work  ');
  reset role;
  select count(*) into n from public.profiles where id = v_mem2 and tier_id = t_sup and setup_complete;
  if n <> 1 then raise exception 'FAIL: Member -> Support did not move the account'; end if;
  select count(*) into n from public.profile_audit
   where profile_id = v_mem2 and event = 'tier' and old_value = 'Member' and new_value = 'Support'
     and actor_id = v_cmd and note = 'Fake note: takes over gear work';
  if n <> 1 then raise exception 'FAIL: the move to Support is not logged with actor and note'; end if;
  -- Kept: the person's own private details are not destroyed by the move.
  select count(*) into n from public.member_private where profile_id = v_mem2;
  if n <> 1 then raise exception 'FAIL: the move to Support deleted private details'; end if;
  -- The note does not leak into later tier changes.
  update public.profiles set tier_id = t_prospect where id = v_mem;
  select count(*) into n from public.profile_audit where profile_id = v_mem and event = 'tier' and note is not null;
  if n <> 0 then raise exception 'FAIL: a tier note leaked into an unrelated tier change'; end if;
  update public.profiles set tier_id = t_mem where id = v_mem;

  -- Support (no private details) -> Member re-opens first-login setup; a player-side account that
  -- already has details does not.
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.move_support_tier(v_sup, t_mem, 'Fake note: now plays');
  perform public.move_support_tier(v_mem2, t_mem, 'Fake note: back to playing');
  reset role;
  select count(*) into n from public.profiles where id = v_sup and tier_id = t_mem and not setup_complete;
  if n <> 1 then raise exception 'FAIL: Support -> Member without details should re-open setup'; end if;
  select count(*) into n from public.profiles where id = v_mem2 and tier_id = t_mem and setup_complete;
  if n <> 1 then raise exception 'FAIL: Support -> Member with details should keep setup complete'; end if;
  select count(*) into n from public.profile_audit where event = 'tier' and note in ('Fake note: now plays', 'Fake note: back to playing');
  if n <> 2 then raise exception 'FAIL: moves out of Support are not logged with their notes'; end if;

  -- The Audit feed shows tier moves with the note, to approvers.
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.list_audit(100, 0) a where a.event = 'tier' and a.detail like 'Member -> Support (Fake note: takes over gear work)';
  if n <> 1 then raise exception 'FAIL: audit feed does not show the tier move note'; end if;
  reset role;

  ------------------------------------------------------------------ an Admin may do it too; removal follows the normal process
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.move_support_tier(v_mem2, t_sup, 'Fake note: Admin move');
  perform public.remove_member(v_mem2, 'Fake removal of a Support account');
  reset role;
  select count(*) into n from public.profiles where id = v_mem2 and status = 'removed' and tier_id = t_sup;
  if n <> 1 then raise exception 'FAIL: a Support account should be removable like any other'; end if;

  raise notice 'support tier: ALL PASS';
end;
$$;

rollback;
