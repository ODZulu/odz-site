-- Tier 1 database tests for MVA-230: event opportunities and member bids.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

create function pg_temp.act(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

do $$
declare
  v_adm uuid := '00000000-0000-0000-0000-0000000000a1';
  v_cmd uuid := '00000000-0000-0000-0000-0000000000c1';
  v_og  uuid := '00000000-0000-0000-0000-0000000000b1';
  v_m1  uuid := '00000000-0000-0000-0000-0000000000d1';
  v_m2  uuid := '00000000-0000-0000-0000-0000000000d2';
  v_m3  uuid := '00000000-0000-0000-0000-0000000000d3';
  v_rec uuid := '00000000-0000-0000-0000-0000000000e1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  oa uuid; ob uuid; oc uuid; od uuid; ev uuid;
  n integer;
  s text;
  r record;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  ------------------------------------------------------------------ seed
  insert into public.invites (code, tier_id)
  select 'oppfake00000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 17) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm, 'adm@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"oppfake0000000010"}'),
    (v_cmd, 'cmd@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"oppfake0000000011"}'),
    (v_og,  'og@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"oppfake0000000012"}'),
    (v_m1,  'm1@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"oppfake0000000013"}'),
    (v_m2,  'm2@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"oppfake0000000014"}'),
    (v_m3,  'm3@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"oppfake0000000015"}'),
    (v_rec, 'rec@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"oppfake0000000016"}');
  update public.profiles set status = 'approved', tier_id = t_mem, is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Og' where id = v_og;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M1' where id = v_m1;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M2' where id = v_m2;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M3' where id = v_m3;
  update public.profiles set status = 'approved', tier_id = t_recruit, setup_complete = true, callsign = 'Fake-Rec' where id = v_rec;

  ------------------------------------------------------------------ default grants
  select count(*) into n from public.tier_capabilities tc join public.tiers t on t.id = tc.tier_id
   where tc.capability_key in ('read_opportunities', 'write_opportunities') and t.name in ('Member', 'Old Guard', 'Command');
  if n <> 6 then raise exception 'FAIL: Member, Old Guard and Command hold read and write (got %)', n; end if;
  select count(*) into n from public.tier_capabilities where capability_key in ('read_opportunities', 'write_opportunities');
  if n <> 6 then raise exception 'FAIL: nobody else holds read or write by default (got %)', n; end if;
  select count(*) into n from public.tier_capabilities tc join public.tiers t on t.id = tc.tier_id
   where tc.capability_key = 'manage_opportunities' and t.name = 'Command';
  if n <> 1 then raise exception 'FAIL: Command holds manage_opportunities'; end if;
  select count(*) into n from public.tier_capabilities where capability_key = 'manage_opportunities';
  if n <> 1 then raise exception 'FAIL: only Command holds manage_opportunities (got %)', n; end if;

  ------------------------------------------------------------------ anon sees and does nothing
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform count(*) from public.opportunities; raise exception 'FAIL: anon read opportunities';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform count(*) from public.opportunity_responses; raise exception 'FAIL: anon read responses';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.opportunity_list(); raise exception 'FAIL: anon listed opportunities';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.opportunity_save(null, 'Fake', null, null, current_date, null, null, null, null, null, null); raise exception 'FAIL: anon created an opportunity';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ a Recruit (no capability) is refused
  perform pg_temp.act(v_rec);
  begin perform public.opportunity_list(); raise exception 'FAIL: Recruit listed opportunities';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.opportunity_save(null, 'Fake', null, null, current_date, null, null, null, null, null, null); raise exception 'FAIL: Recruit created an opportunity';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  select count(*) into n from public.opportunities;
  if n <> 0 then raise exception 'FAIL: Recruit sees rows'; end if;
  reset role;

  ------------------------------------------------------------------ Member creates and edits their own
  perform pg_temp.act(v_m1);
  oa := public.opportunity_save(null, '  Fake Weekend Game  ', 'Fake Host', 'https://example.invalid/event', current_date + 30, current_date + 31,
                                'Fake Field', 33.4, -112.0, 5000, 'Fake notes');
  select title into s from public.opportunities where id = oa;
  if s <> 'Fake Weekend Game' then raise exception 'FAIL: title should be trimmed (got %)', s; end if;
  perform public.opportunity_save(oa, 'Fake Weekend Game', 'Fake Host', null, current_date + 30, current_date + 32, 'Fake Field', 33.4, -112.0, 5000, 'Edited');
  select notes into s from public.opportunities where id = oa;
  if s <> 'Edited' then raise exception 'FAIL: own edit did not apply'; end if;
  -- Direct writes are closed.
  begin insert into public.opportunities (title, starts_on) values ('Fake direct', current_date); raise exception 'FAIL: direct insert allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin update public.opportunities set title = 'Fake hijack' where id = oa; raise exception 'FAIL: direct update allowed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- Another Member cannot edit it; Command can.
  perform pg_temp.act(v_m2);
  begin perform public.opportunity_save(oa, 'Fake taken', null, null, current_date + 30, null, null, null, null, null, null); raise exception 'FAIL: Member edited another''s opportunity';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform pg_temp.act(v_cmd);
  perform public.opportunity_save(oa, 'Fake Weekend Game', 'Fake Host', null, current_date + 30, current_date + 32, 'Fake Field', 33.4, -112.0, 5000, 'Command edit');
  select notes into s from public.opportunities where id = oa;
  if s <> 'Command edit' then raise exception 'FAIL: Command edit did not apply'; end if;
  reset role;

  ------------------------------------------------------------------ validation
  perform pg_temp.act(v_m1);
  begin perform public.opportunity_save(null, 'Fake', null, null, current_date + 5, current_date + 1, null, null, null, null, null); raise exception 'FAIL: end before start accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.opportunity_save(null, 'Fake', null, 'javascript:alert(1)', current_date + 5, null, null, null, null, null, null); raise exception 'FAIL: bad URL accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.opportunity_save(null, 'Fake', null, null, current_date + 5, null, null, 95, 10, null, null); raise exception 'FAIL: latitude 95 accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.opportunity_save(null, 'Fake', null, null, current_date + 5, null, null, 33, null, null, null); raise exception 'FAIL: half a coordinate accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.opportunity_save(null, 'Fake', null, null, current_date + 5, null, null, null, null, -1, null); raise exception 'FAIL: negative cost accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.opportunity_save(null, '   ', null, null, current_date + 5, null, null, null, null, null, null); raise exception 'FAIL: blank title accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ interest: one answer each, changeable, counts, privacy
  perform pg_temp.act(v_m1); perform public.opportunity_respond(oa, 'In');
  perform public.opportunity_respond(oa, 'Maybe');           -- changed its mind
  reset role;
  perform pg_temp.act(v_m2); perform public.opportunity_respond(oa, 'In'); reset role;
  perform pg_temp.act(v_m3); perform public.opportunity_respond(oa, 'Out');
  begin perform public.opportunity_respond(oa, 'Perhaps'); raise exception 'FAIL: bad response accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_response' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select count(*) into n from public.opportunity_responses where opportunity_id = oa;
  if n <> 3 then raise exception 'FAIL: one response per member (got %)', n; end if;

  perform pg_temp.act(v_m1);
  select * into r from public.opportunity_list() where id = oa;
  if r.in_count <> 1 or r.maybe_count <> 1 or r.out_count <> 1 then raise exception 'FAIL: counts % % %', r.in_count, r.maybe_count, r.out_count; end if;
  if r.my_response <> 'Maybe' then raise exception 'FAIL: own response (got %)', r.my_response; end if;
  select count(*) into n from public.opportunity_responses;
  if n <> 1 then raise exception 'FAIL: a Member sees only their own response row (got %)', n; end if;
  begin perform public.opportunity_responders(oa); raise exception 'FAIL: Member listed responders';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  perform pg_temp.act(v_og);
  select count(*) into n from public.opportunity_responders(oa);
  if n <> 3 then raise exception 'FAIL: Old Guard sees who answered (got %)', n; end if;
  select count(*) into n from public.opportunity_responses;
  if n <> 3 then raise exception 'FAIL: Old Guard reads all responses (got %)', n; end if;
  reset role;
  perform pg_temp.act(v_cmd);
  select count(*) into n from public.opportunity_responders(oa);
  if n <> 3 then raise exception 'FAIL: Command sees who answered (got %)', n; end if;
  reset role;

  ------------------------------------------------------------------ drop and promote are Command's
  perform pg_temp.act(v_m1);
  begin perform public.opportunity_drop(oa, 'Fake reason'); raise exception 'FAIL: Member dropped';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.opportunity_promote(oa, 'Op'); raise exception 'FAIL: Member promoted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform pg_temp.act(v_og);
  begin perform public.opportunity_promote(oa, 'Op'); raise exception 'FAIL: Old Guard promoted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  -- Promotion: event created, linked, In and Maybe told, Out not, nobody registered.
  perform pg_temp.act(v_cmd);
  begin perform public.opportunity_promote(oa, 'Bogus'); raise exception 'FAIL: bad event type accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_event_type' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  ev := public.opportunity_promote(oa, 'Op');
  reset role;
  select status, event_id into r from public.opportunities where id = oa;
  if r.status <> 'promoted' or r.event_id is distinct from ev then raise exception 'FAIL: opportunity not marked promoted and linked'; end if;
  select count(*) into n from public.events where id = ev and title = 'Fake Weekend Game' and event_type = 'Op';
  if n <> 1 then raise exception 'FAIL: event not created'; end if;
  select count(*) into n from public.event_details where event_id = ev and location_name = 'Fake Field' and description like '%Host: Fake Host%';
  if n <> 1 then raise exception 'FAIL: event details not carried over'; end if;
  select count(*) into n from public.notifications where kind = 'opportunity' and title like 'Now an event:%' and profile_id in (v_m1, v_m2);
  if n <> 2 then raise exception 'FAIL: In and Maybe should be told (got %)', n; end if;
  select count(*) into n from public.notifications where kind = 'opportunity' and profile_id = v_m3;
  if n <> 0 then raise exception 'FAIL: Out should not be told of the promotion'; end if;
  select count(*) into n from public.event_rsvps where event_id = ev;
  if n <> 0 then raise exception 'FAIL: promotion must not register anyone'; end if;
  -- Closed: no more interest, no second promotion, no edits.
  perform pg_temp.act(v_m2);
  begin perform public.opportunity_respond(oa, 'Out'); raise exception 'FAIL: responded after promotion';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_open' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform pg_temp.act(v_cmd);
  begin perform public.opportunity_promote(oa, 'Op'); raise exception 'FAIL: promoted twice';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_open' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.opportunity_save(oa, 'Fake', null, null, current_date + 30, null, null, null, null, null, null); raise exception 'FAIL: edited after promotion';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_open' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select count(*) into n from public.opportunity_responses where opportunity_id = oa;
  if n <> 3 then raise exception 'FAIL: interest is kept after promotion'; end if;

  ------------------------------------------------------------------ drop
  perform pg_temp.act(v_m1);
  ob := public.opportunity_save(null, 'Fake Second', null, null, current_date + 10, null, null, null, null, null, null);
  perform public.opportunity_respond(ob, 'In');
  reset role;
  perform pg_temp.act(v_m2); perform public.opportunity_respond(ob, 'Out'); reset role;
  perform pg_temp.act(v_cmd);
  begin perform public.opportunity_drop(ob, 'x'); raise exception 'FAIL: drop without a real reason';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'invalid_reason' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  perform public.opportunity_drop(ob, 'Fake: clashes with another date');
  reset role;
  select status, drop_reason into r from public.opportunities where id = ob;
  if r.status <> 'dropped' or r.drop_reason is null then raise exception 'FAIL: not dropped'; end if;
  select count(*) into n from public.notifications where kind = 'opportunity' and title like 'Opportunity dropped:%' and profile_id in (v_m1, v_m2);
  if n <> 2 then raise exception 'FAIL: everyone who answered is told of a drop (got %)', n; end if;
  select count(*) into n from public.opportunity_responses where opportunity_id = ob;
  if n <> 2 then raise exception 'FAIL: interest kept after a drop'; end if;
  perform pg_temp.act(v_m1);
  begin perform public.opportunity_respond(ob, 'Maybe'); raise exception 'FAIL: responded after drop';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_open' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  ------------------------------------------------------------------ expiry
  insert into public.opportunities (title, starts_on, ends_on, created_by)
  values ('Fake Past', public.phoenix_today() - 10, public.phoenix_today() - 8, v_m1) returning id into oc;
  insert into public.opportunities (title, starts_on, created_by)
  values ('Fake Today', public.phoenix_today(), v_m1) returning id into od;
  perform pg_temp.act(v_m1);
  select status into s from public.opportunity_list() where id = oc;
  if s <> 'expired' then raise exception 'FAIL: past opportunity should be expired (got %)', s; end if;
  select status into s from public.opportunity_list() where id = od;
  if s <> 'open' then raise exception 'FAIL: an opportunity on its last day is still open (got %)', s; end if;
  begin perform public.opportunity_respond(oc, 'In'); raise exception 'FAIL: responded to an expired opportunity';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_open' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;

  ------------------------------------------------------------------ Admin passes every capability; list is ordered by start date
  perform pg_temp.act(v_adm);
  select count(*) into n from public.opportunity_list();
  if n <> 4 then raise exception 'FAIL: Admin list (got %)', n; end if;
  select min(starts_on) = (select starts_on from public.opportunity_list() limit 1) into s from public.opportunities;
  if s is distinct from 'true' then raise exception 'FAIL: list should start with the earliest date'; end if;
  reset role;

  raise notice 'event_opportunities: ALL PASS';
end $$;

rollback;
