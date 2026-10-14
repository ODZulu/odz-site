-- Tier 1 database tests for MVA-234: Old Guard / Command seat caps.
-- Plain SQL, one rolled-back transaction, fake data only. (The concurrent-promotion race is in
-- e2e/seat-caps.spec.ts: one transaction cannot race itself.)

begin;

do $$
declare
  v_adm  uuid := '00000000-0000-0000-0000-0000000000a1';
  v_cmd  uuid := '00000000-0000-0000-0000-0000000000c1';
  v_b    uuid := '00000000-0000-0000-0000-0000000000b1';
  v_c    uuid := '00000000-0000-0000-0000-0000000000b2';
  v_d    uuid := '00000000-0000-0000-0000-0000000000b3';
  v_e    uuid := '00000000-0000-0000-0000-0000000000b4';
  v_f    uuid := '00000000-0000-0000-0000-0000000000b5';
  v_pend uuid := '00000000-0000-0000-0000-0000000000d1';
  v_sup  uuid := '00000000-0000-0000-0000-0000000000e1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid; t_sup uuid;
  n integer;
  r record;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';
  select id into t_sup from public.tiers where name = 'Support';

  ------------------------------------------------------------------ seed
  select count(*) into n from public.seat_caps where old_guard_max = 12 and command_max = 3;
  if n <> 1 then raise exception 'FAIL: caps should start at 12 and 3'; end if;
  select count(*) into n from public.tiers where (name = 'Old Guard' and seat_group = 'old_guard') or (name = 'Command' and seat_group = 'command');
  if n <> 2 then raise exception 'FAIL: Old Guard and Command should carry their seat groups'; end if;
  select count(*) into n from public.tiers where seat_group is not null;
  if n <> 2 then raise exception 'FAIL: only Old Guard and Command hold seats (got %)', n; end if;

  insert into public.invites (code, tier_id)
  select 'seatfake000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 18) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm,  'adm@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"seatfake000000010"}'),
    (v_cmd,  'cmd@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"seatfake000000011"}'),
    (v_b,    'b@example.invalid',    'authenticated', 'authenticated', '{"invite_code":"seatfake000000012"}'),
    (v_c,    'c@example.invalid',    'authenticated', 'authenticated', '{"invite_code":"seatfake000000013"}'),
    (v_d,    'd@example.invalid',    'authenticated', 'authenticated', '{"invite_code":"seatfake000000014"}'),
    (v_e,    'e@example.invalid',    'authenticated', 'authenticated', '{"invite_code":"seatfake000000015"}'),
    (v_f,    'f@example.invalid',    'authenticated', 'authenticated', '{"invite_code":"seatfake000000016"}'),
    (v_pend, 'pend@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"seatfake000000017"}'),
    (v_sup,  'sup@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"seatfake000000018"}');
  update public.profiles set status = 'approved', is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-B' where id = v_b;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-C' where id = v_c;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-D' where id = v_d;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-E' where id = v_e;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-F' where id = v_f;
  update public.profiles set setup_complete = true, callsign = 'Fake-Pend' where id = v_pend;
  update public.profiles set status = 'approved', tier_id = t_sup, setup_complete = true, callsign = 'Fake-Sup' where id = v_sup;

  -- Command is part of Old Guard: 1 Command + 2 Old Guard = 3 seats of Old Guard.
  if public.seat_tally('old_guard') <> 3 then raise exception 'FAIL: Old Guard tally should include Command (got %)', public.seat_tally('old_guard'); end if;
  if public.seat_tally('command') <> 1 then raise exception 'FAIL: Command tally (got %)', public.seat_tally('command'); end if;

  ------------------------------------------------------------------ who changes the caps
  perform set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.set_seat_caps(4, 2); raise exception 'FAIL: Member changed the caps';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.set_seat_caps(4, 2); raise exception 'FAIL: Command changed the caps';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform public.set_seat_caps(4, 2); raise exception 'FAIL: anon changed the caps';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.seat_counts(); raise exception 'FAIL: anon read seat counts';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.set_seat_caps(2, 3); raise exception 'FAIL: Command cap above Old Guard cap accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_caps' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.set_seat_caps(0, 0); raise exception 'FAIL: zero caps accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_caps' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.set_seat_caps(100, 3); raise exception 'FAIL: cap of 100 accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_caps' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.set_seat_caps(null, 3); raise exception 'FAIL: null cap accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_caps' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin update public.seat_caps set old_guard_max = 50; raise exception 'FAIL: direct cap update allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.seat_caps (singleton, old_guard_max, command_max) values (false, 5, 1); raise exception 'FAIL: direct cap insert allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  -- Unchanged values log nothing.
  perform public.set_seat_caps(12, 3);
  perform public.set_seat_caps(4, 2);
  reset role;
  select count(*) into n from public.seat_caps where old_guard_max = 4 and command_max = 2 and updated_by = v_adm;
  if n <> 1 then raise exception 'FAIL: caps not updated with the actor'; end if;
  select count(*) into n from public.settings_audit where event = 'seat_caps_changed';
  if n <> 1 then raise exception 'FAIL: expected exactly one cap-change log row (got %)', n; end if;
  select count(*) into n from public.settings_audit
   where event = 'seat_caps_changed' and actor_id = v_adm and detail = 'old_guard 12 -> 4, command 3 -> 2';
  if n <> 1 then raise exception 'FAIL: cap change not logged with who, old and new'; end if;

  ------------------------------------------------------------------ Old Guard cap (Command counts inside it)
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set tier_id = t_og where id = v_d;            -- 3 -> 4 of 4
  begin update public.profiles set tier_id = t_og where id = v_e; raise exception 'FAIL: Old Guard exceeded its cap';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'Old Guard is full: 4/4' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  select count(*) into n from public.profiles where id = v_e and tier_id = t_mem;
  if n <> 1 then raise exception 'FAIL: a refused promotion still moved someone'; end if;

  ------------------------------------------------------------------ Command cap, entry rule unchanged
  begin update public.profiles set tier_id = t_cmd where id = v_f; raise exception 'FAIL: Member went straight to Command';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  update public.profiles set tier_id = t_cmd where id = v_b;           -- Command 1 -> 2 of 2; Old Guard tally unchanged
  if (select count(*) from public.profiles where tier_id in (t_og, t_cmd)) <> 4 then raise exception 'FAIL: promoting within Old Guard changed the tally'; end if;
  begin update public.profiles set tier_id = t_cmd where id = v_c; raise exception 'FAIL: Command exceeded its cap';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'Command is full: 2/2' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;

  -- Leaving Command returns to Old Guard (release rule), keeps the Old Guard tally, frees a Command seat.
  update public.profiles set tier_id = t_mem where id = v_b;
  select count(*) into n from public.profiles where id = v_b and tier_id = t_og;
  if n <> 1 then raise exception 'FAIL: leaving Command should return the member to Old Guard'; end if;
  update public.profiles set tier_id = t_cmd where id = v_c;           -- the freed Command seat
  reset role;
  if public.seat_tally('old_guard') <> 4 or public.seat_tally('command') <> 2 then
    raise exception 'FAIL: tallies after the Command swap (og %, cmd %)', public.seat_tally('old_guard'), public.seat_tally('command');
  end if;

  ------------------------------------------------------------------ demotion frees a seat at once
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set tier_id = t_mem where id = v_d;           -- Old Guard 4 -> 3
  update public.profiles set tier_id = t_og where id = v_e;            -- 3 -> 4 again
  begin update public.profiles set tier_id = t_og where id = v_f; raise exception 'FAIL: Old Guard exceeded its cap after a swap';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'Old Guard is full: 4/4' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  ------------------------------------------------------------------ soft removal frees a seat at once
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.remove_member(v_e, 'Fake removal frees the seat');
  reset role;
  if public.seat_tally('old_guard') <> 3 then raise exception 'FAIL: removal should free the seat (got %)', public.seat_tally('old_guard'); end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set tier_id = t_og where id = v_f;            -- the freed seat
  reset role;
  if public.seat_tally('old_guard') <> 4 then raise exception 'FAIL: tally after using the freed seat'; end if;

  ------------------------------------------------------------------ hard delete frees a seat at once
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.delete_removed_member(v_e, 'Fake deletion');
  reset role;
  if public.seat_tally('old_guard') <> 4 then raise exception 'FAIL: deleting a removed member changed the tally'; end if;

  ------------------------------------------------------------------ suspended keeps the seat; pending holds none
  update public.profiles set status = 'suspended' where id = v_f;
  if public.seat_tally('old_guard') <> 4 then raise exception 'FAIL: a suspended member should keep the seat'; end if;
  update public.profiles set status = 'approved' where id = v_f;

  -- A pending account can be given the tier while full (it takes no seat), but approval is refused.
  update public.profiles set tier_id = t_og where id = v_pend;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.approve_member(v_pend); raise exception 'FAIL: approval took a seat past the cap';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'Old Guard is full: 4/4' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select count(*) into n from public.profiles where id = v_pend and status = 'pending';
  if n <> 1 then raise exception 'FAIL: a refused approval still approved the account'; end if;

  ------------------------------------------------------------------ lowering a cap applies to future moves only
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_seat_caps(2, 1);
  reset role;
  if public.seat_tally('old_guard') <> 4 or public.seat_tally('command') <> 2 then
    raise exception 'FAIL: lowering the caps moved someone';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin update public.profiles set tier_id = t_og where id = v_d; raise exception 'FAIL: promotion allowed while over the cap';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'Old Guard is full: 4/2' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  -- Existing seat holders can still be edited.
  update public.profiles set tier_id = t_og where id = v_c;            -- Command -> Old Guard
  reset role;

  ------------------------------------------------------------------ the bulk / editor path is covered too
  begin update public.profiles set tier_id = t_og where id = v_d; raise exception 'FAIL: SQL-editor path skipped the cap';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'Old Guard is full: 4/2' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin insert into public.invites (tier_id) values (t_og); raise exception 'FAIL: an invite carried Old Guard';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invites cannot grant that tier' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin insert into public.invites (tier_id) values (t_cmd); raise exception 'FAIL: an invite carried Command';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invites cannot grant that tier' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;

  ------------------------------------------------------------------ counters: who may read them
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into r from public.seat_counts();
  if r.old_guard_count <> 4 or r.old_guard_max <> 2 or r.command_count <> 1 or r.command_max <> 1 then
    raise exception 'FAIL: seat counts wrong for a seat holder (og %/%, cmd %/%)', r.old_guard_count, r.old_guard_max, r.command_count, r.command_max;
  end if;
  select count(*) into n from public.seat_caps;
  if n <> 1 then raise exception 'FAIL: approved members should read the caps'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.seat_counts(); raise exception 'FAIL: a plain Member read seat counts';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.seat_counts(); raise exception 'FAIL: Support read seat counts';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.seat_counts();
  reset role;

  raise notice 'seat caps: ALL PASS';
end;
$$;

rollback;
