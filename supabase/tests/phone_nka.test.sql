-- Tier 1 database tests for MVA-207: canonical phone format and NKA, enforced in the database.
-- Plain SQL, one rolled-back transaction, fake data only (555-01xx numbers).

begin;

do $$
declare
  v_a uuid := '00000000-0000-0000-0000-0000000000a7';
  v_b uuid := '00000000-0000-0000-0000-0000000000b7';
  t_recruit uuid;
  n integer;
  s text;
begin
  select id into t_recruit from public.tiers where name = 'Recruit';

  ------------------------------------------------------------------ normalize_phone
  if public.normalize_phone('(555) 010-0100') <> '555-010-0100' then raise exception 'FAIL: parens'; end if;
  if public.normalize_phone('555.010.0100') <> '555-010-0100' then raise exception 'FAIL: dots'; end if;
  if public.normalize_phone('5550100100') <> '555-010-0100' then raise exception 'FAIL: bare digits'; end if;
  if public.normalize_phone('+1 555 010 0100') <> '555-010-0100' then raise exception 'FAIL: +1'; end if;
  if public.normalize_phone('1-555-010-0100') <> '555-010-0100' then raise exception 'FAIL: 1-'; end if;
  if public.normalize_phone('555010010') is not null then raise exception 'FAIL: 9 digits accepted'; end if;
  if public.normalize_phone('55501001000') is not null then raise exception 'FAIL: 11 digits not starting 1 accepted'; end if;
  if public.normalize_phone('abc') is not null then raise exception 'FAIL: letters accepted'; end if;
  if public.normalize_phone(null) is not null then raise exception 'FAIL: null accepted'; end if;

  ------------------------------------------------------------------ normalize_allergies
  if public.normalize_allergies('  None ') <> 'NKA' then raise exception 'FAIL: none'; end if;
  if public.normalize_allergies('N/A') <> 'NKA' then raise exception 'FAIL: n/a'; end if;
  if public.normalize_allergies('nka') <> 'NKA' then raise exception 'FAIL: nka'; end if;
  if public.normalize_allergies('Penicillin ') <> 'Penicillin' then raise exception 'FAIL: kept text'; end if;
  if public.normalize_allergies('none of these') <> 'none of these' then raise exception 'FAIL: partial match'; end if;

  ------------------------------------------------------------------ complete_setup stores canonical
  insert into public.invites (code, tier_id)
  select 'phonefake0000000' || g, t_recruit from generate_series(1, 2) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_a, 'a7@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"phonefake00000001"}'),
    (v_b, 'b7@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"phonefake00000002"}');

  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;

  begin
    perform public.complete_setup('Fake-Ph-A', 'Fake Name', date '1990-01-01', '555-010', 'NKA', 'Fake Contact', 'Friend', '555-010-0100');
    raise exception 'FAIL: short optional phone accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm <> 'invalid_phone' then raise exception 'FAIL: wrong error %', sqlerrm; end if;
  end;
  begin
    perform public.complete_setup('Fake-Ph-A', 'Fake Name', date '1990-01-01', null, 'NKA', 'Fake Contact', 'Friend', '');
    raise exception 'FAIL: empty emergency phone accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm <> 'invalid_emergency_phone' then raise exception 'FAIL: wrong error %', sqlerrm; end if;
  end;

  perform public.complete_setup('Fake-Ph-A', 'Fake Name', date '1990-01-01', '(555) 010-0102', ' none ', 'Fake Contact', 'Friend', '+1 555 010 0103');
  select phone || '|' || allergies || '|' || emergency_phone into s from public.member_private where profile_id = v_a;
  if s <> '555-010-0102|NKA|555-010-0103' then raise exception 'FAIL: complete_setup did not store canonical values'; end if;

  -- Other allergy text is stored as entered (trimmed).
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.complete_setup('Fake-Ph-B', 'Fake Name', date '1990-01-01', null, ' Fake Peanuts ', 'Fake Contact', 'Friend', '555.010.0104');
  select coalesce(phone, 'null') || '|' || allergies || '|' || emergency_phone into s from public.member_private where profile_id = v_b;
  if s <> 'null|Fake Peanuts|555-010-0104' then raise exception 'FAIL: optional phone or free-text allergies wrong'; end if;

  ------------------------------------------------------------------ update_own_private normalizes too
  perform public.update_own_private('Fake Name', date '1990-01-01', '5550100105', 'N/A', 'Fake Contact', 'Friend', '(555) 010-0106');
  select phone || '|' || allergies || '|' || emergency_phone into s from public.member_private where profile_id = v_b;
  if s <> '555-010-0105|NKA|555-010-0106' then raise exception 'FAIL: update_own_private did not store canonical values'; end if;
  begin
    perform public.update_own_private('Fake Name', date '1990-01-01', null, 'NKA', 'Fake Contact', 'Friend', '12345');
    raise exception 'FAIL: bad emergency phone accepted on update';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm <> 'invalid_emergency_phone' then raise exception 'FAIL: wrong error %', sqlerrm; end if;
  end;
  reset role;

  ------------------------------------------------------------------ CHECK constraints reject non-canonical rows
  begin
    update public.member_private set phone = '5550100100' where profile_id = v_a;
    raise exception 'FAIL: CHECK accepted bare digits';
  exception when check_violation then null; end;
  begin
    update public.member_private set phone = '(555) 010-0100' where profile_id = v_a;
    raise exception 'FAIL: CHECK accepted parens';
  exception when check_violation then null; end;
  begin
    update public.member_private set emergency_phone = '555 010 0100' where profile_id = v_a;
    raise exception 'FAIL: CHECK accepted spaces in emergency phone';
  exception when check_violation then null; end;
  update public.member_private set phone = null where profile_id = v_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: null phone should be allowed'; end if;

  ------------------------------------------------------------------ helpers are not callable by clients
  set local role authenticated;
  begin
    perform public.normalize_phone('5550100100');
    raise exception 'FAIL: authenticated can call normalize_phone';
  exception when insufficient_privilege then null; end;
  reset role;

  raise notice 'phone_nka: ALL PASS';
end;
$$;

rollback;
