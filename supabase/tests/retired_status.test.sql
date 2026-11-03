-- Tier 1 database tests for MVA-238: Retired status (retire/unretire RPCs, seat release,
-- designations vacated, limited access, audit, permissions).
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_adm  uuid := '00000000-0000-0000-0000-0000000000a8';
  v_cmd  uuid := '00000000-0000-0000-0000-0000000000a9';
  v_ogA  uuid := '00000000-0000-0000-0000-0000000000b8';
  v_ogB  uuid := '00000000-0000-0000-0000-0000000000b9';
  v_mem  uuid := '00000000-0000-0000-0000-0000000000c8';
  v_mem2 uuid := '00000000-0000-0000-0000-0000000000c9';
  v_pend uuid := '00000000-0000-0000-0000-0000000000d8';
  t_cmd uuid; t_og uuid; t_mem uuid;
  d_treasurer uuid; d_shop uuid;
  ev uuid; mn uuid;
  n integer;
  vac text[];
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into d_treasurer from public.designations where name = 'Treasurer';
  select id into d_shop from public.designations where name = 'Shop Manager';

  ------------------------------------------------------------------ seed fake accounts
  insert into public.invites (code, tier_id)
  select 'retfake0000000' || to_char(g, 'FM00'), (select id from public.tiers where name = 'Recruit') from generate_series(10, 16) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm,  'ret-adm@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"retfake000000010"}'),
    (v_cmd,  'ret-cmd@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"retfake000000011"}'),
    (v_ogA,  'ret-oga@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"retfake000000012"}'),
    (v_ogB,  'ret-ogb@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"retfake000000013"}'),
    (v_mem,  'ret-mem@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"retfake000000014"}'),
    (v_mem2, 'ret-mem2@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"retfake000000015"}'),
    (v_pend, 'ret-pend@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"retfake000000016"}');
  update public.profiles set status = 'approved', is_admin = true, setup_complete = true, callsign = 'Fake-Ret-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Ret-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Ret-OgA' where id = v_ogA;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Ret-OgB' where id = v_ogB;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Ret-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Ret-Mem2' where id = v_mem2;
  update public.profiles set setup_complete = true, callsign = 'Fake-Ret-Pend' where id = v_pend;

  -- A service record entry, a designation pair, and rows a retired member must not read.
  insert into public.service_records (profile_id, doe) values (v_ogA, date '2016-01-01');
  insert into public.member_designations (profile_id, designation_id) values (v_ogA, d_treasurer), (v_ogA, d_shop);
  insert into public.member_private (profile_id, legal_name, dob, allergies, emergency_name, emergency_relationship, emergency_phone)
  values (v_mem, 'Fake Legal Name', date '1990-01-02', 'Fake allergy', 'Fake Contact', 'Friend', '555-010-0100');
  insert into public.events (title, event_type, starts_at, ends_at)
  values ('Fake Game', 'Game Day', now() + interval '3 days', now() + interval '3 days 4 hours') returning id into ev;
  insert into public.event_details (event_id, location_name, location_detail, description) values (ev, 'Fake Field', 'Fake gate', 'Fake brief');
  insert into public.minutes (title, meeting_date, body_md, status) values ('Fake Minutes', current_date, 'Fake notes', 'published') returning id into mn;
  insert into public.traffic (title, body) values ('Fake notice', 'Fake body text');

  -- Cap Old Guard at 3 (Command counts inside it): Cmd + OgA + OgB = full.
  update public.seat_caps set old_guard_max = 3, command_max = 2 where singleton;
  if public.seat_tally('old_guard') <> 3 then raise exception 'FAIL: Old Guard tally should be 3 (got %)', public.seat_tally('old_guard'); end if;

  ------------------------------------------------------------------ permissions
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.retire_member(v_mem2, 'x'); raise exception 'FAIL: a plain Member retired someone';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.unretire_member(v_mem2); raise exception 'FAIL: a plain Member unretired someone';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform public.retire_member(v_mem2, 'x'); raise exception 'FAIL: anon retired someone';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.retire_member(v_cmd, null); raise exception 'FAIL: retired self';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'cannot_retire_self' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.retire_member(v_adm, null); raise exception 'FAIL: Command retired an Admin';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.retire_member(v_pend, null); raise exception 'FAIL: retired a pending account';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_active' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.retire_member(v_mem2, repeat('x', 301)); raise exception 'FAIL: 301-char reason';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.retire_member('00000000-0000-0000-0000-00000000ffff', null); raise exception 'FAIL: retired a stranger';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_found' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.unretire_member(v_mem2); raise exception 'FAIL: unretired someone who is not retired';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_retired' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  -- Direct status writes stay closed: retired is reachable only through the RPC for non-approvers' paths too.
  reset role;

  ------------------------------------------------------------------ Old Guard is full; retiring frees a seat
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin update public.profiles set tier_id = t_og where id = v_mem; raise exception 'FAIL: promoted into a full Old Guard';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm not like 'Old Guard is full: 3/3%' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;

  vac := public.retire_member(v_ogA, '  moved on to other games  ');
  reset role;

  select count(*) into n from public.profiles
   where id = v_ogA and status = 'retired' and retired_from_tier = t_og and retired_at is not null and tier_id = t_og;
  if n <> 1 then raise exception 'FAIL: retired profile should be status retired with the prior tier remembered'; end if;
  if public.seat_tally('old_guard') <> 2 then raise exception 'FAIL: retiring Old Guard should drop the tally to 2 (got %)', public.seat_tally('old_guard'); end if;

  -- Designations vacated and logged; the function reports their names.
  if vac is distinct from array['Shop Manager', 'Treasurer'] then raise exception 'FAIL: wrong vacated list %', vac; end if;
  select count(*) into n from public.member_designations where profile_id = v_ogA;
  if n <> 0 then raise exception 'FAIL: designations should be vacated (got %)', n; end if;
  select count(*) into n from public.designation_audit where profile_id = v_ogA and action = 'revoked' and actor_id = v_cmd;
  if n <> 2 then raise exception 'FAIL: expected two revoked audit rows (got %)', n; end if;

  -- Service record untouched.
  select count(*) into n from public.service_records where profile_id = v_ogA and doe = date '2016-01-01';
  if n <> 1 then raise exception 'FAIL: service record should be intact'; end if;

  -- Audit: who, when, tier, reason (trimmed).
  select count(*) into n from public.profile_audit
   where profile_id = v_ogA and event = 'retired' and actor_id = v_cmd and old_value = 'Old Guard' and new_value = 'Retired' and note = 'moved on to other games';
  if n <> 1 then raise exception 'FAIL: retire audit row missing or wrong'; end if;

  -- The freed seat is usable at the cap.
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set tier_id = t_og where id = v_mem;
  reset role;
  if public.seat_tally('old_guard') <> 3 then raise exception 'FAIL: promotion into the freed seat should fill Old Guard again'; end if;

  -- Retiring twice is refused.
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.retire_member(v_ogA, null); raise exception 'FAIL: retired twice';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_active' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  ------------------------------------------------------------------ what a Retired member can and cannot read
  perform set_config('request.jwt.claims', json_build_object('sub', v_ogA, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = v_ogA;
  if n <> 1 then raise exception 'FAIL: a retired member should read their own profile'; end if;
  select count(*) into n from public.traffic;
  if n < 1 then raise exception 'FAIL: a retired member should read Traffic'; end if;
  select count(*) into n from public.service_records where profile_id = v_ogA;
  if n <> 1 then raise exception 'FAIL: a retired member should read their own service record'; end if;
  if public.has_capability('read_event_details') or public.has_capability('read_minutes') or public.has_capability('edit_roster') then
    raise exception 'FAIL: a retired member holds a capability';
  end if;
  if exists (select 1 from public.my_capabilities()) then raise exception 'FAIL: my_capabilities should be empty for a retired member'; end if;
  select count(*) into n from public.event_details;
  if n <> 0 then raise exception 'FAIL: a retired member read event_details'; end if;
  -- (events itself, title and time only, is public like the calendar; the gated part is event_details.)
  select count(*) into n from public.minutes;
  if n <> 0 then raise exception 'FAIL: a retired member read minutes'; end if;
  select count(*) into n from public.member_private where profile_id = v_mem;
  if n <> 0 then raise exception 'FAIL: a retired member read another member''s private details'; end if;
  begin perform public.retire_member(v_mem2, null); raise exception 'FAIL: a retired member retired someone';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  -- No update policy applies to them, so the write is filtered out (or refused); either way nothing changes.
  begin update public.profiles set status = 'approved' where id = v_ogA;
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  select count(*) into n from public.profiles where id = v_ogA and status = 'retired';
  if n <> 1 then raise exception 'FAIL: a retired member un-retired themself'; end if;

  -- Active members still read the public roster fields of the retired (for the Retired section).
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = v_ogA and status = 'retired';
  if n <> 1 then raise exception 'FAIL: approved members should see retired members in the roster data'; end if;
  reset role;

  ------------------------------------------------------------------ unretire
  -- Old Guard is full again (Cmd + OgB + Mem = 3): the prior seat is gone, so the call is refused
  -- and nothing changes; Command then picks a tier with room.
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.unretire_member(v_ogA); raise exception 'FAIL: unretired into a full Old Guard';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm not like 'Old Guard is full: 3/3%' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select count(*) into n from public.profiles where id = v_ogA and status = 'retired' and tier_id = t_og and retired_from_tier = t_og;
  if n <> 1 then raise exception 'FAIL: a refused unretire should change nothing'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.unretire_member(v_ogA, '00000000-0000-0000-0000-00000000ffff'); raise exception 'FAIL: unretired into a missing tier';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_tier' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.unretire_member(v_ogA, t_mem);
  reset role;
  select count(*) into n from public.profiles where id = v_ogA and status = 'approved' and tier_id = t_mem and retired_at is null and retired_from_tier is null;
  if n <> 1 then raise exception 'FAIL: unretire into another tier should leave an approved Member'; end if;
  select count(*) into n from public.member_designations where profile_id = v_ogA;
  if n <> 0 then raise exception 'FAIL: designations should not come back on return'; end if;
  select count(*) into n from public.profile_audit
   where profile_id = v_ogA and event = 'unretired' and actor_id = v_cmd and old_value = 'Retired' and new_value = 'Member';
  if n <> 1 then raise exception 'FAIL: unretire audit row missing'; end if;
  select count(*) into n from public.service_records where profile_id = v_ogA and doe = date '2016-01-01';
  if n <> 1 then raise exception 'FAIL: service record should survive retire and unretire'; end if;

  -- With a free seat, a second member returns to the prior tier. Retire OgB, free the seat, then restore.
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.retire_member(v_ogB, null);
  perform public.unretire_member(v_ogB);
  reset role;
  select count(*) into n from public.profiles where id = v_ogB and status = 'approved' and tier_id = t_og;
  if n <> 1 then raise exception 'FAIL: unretire with a free seat should restore the prior tier'; end if;

  ------------------------------------------------------------------ audit feed
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.list_audit(100, 0) where event in ('retired', 'unretired') and target like 'Fake-Ret-%';
  if n < 3 then raise exception 'FAIL: retire and unretire events should appear in the audit feed (got %)', n; end if;
  reset role;

  raise notice 'retired status: ALL PASS';
end;
$$;

rollback;
