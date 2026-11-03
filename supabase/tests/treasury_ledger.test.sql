-- Tier 1 database tests for MVA-216: treasury ledger core.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

-- Run a statement as the current role and return the error text ('ok' when it succeeded).
create function pg_temp.try(sql text) returns text language plpgsql as $f$
begin
  execute sql;
  return 'ok';
exception when others then
  return sqlerrm;
end;
$f$;

create function pg_temp.act(u uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$f$;

do $$
declare
  v_adm uuid := '00000000-0000-0000-0000-0000000000a1';
  c1 uuid := '00000000-0000-0000-0000-0000000000c1';
  o1 uuid := '00000000-0000-0000-0000-0000000000b1';
  o2 uuid := '00000000-0000-0000-0000-0000000000b2';
  m1 uuid := '00000000-0000-0000-0000-0000000000d1';
  m2 uuid := '00000000-0000-0000-0000-0000000000d2';
  rec uuid := '00000000-0000-0000-0000-0000000000d3';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid; d_tre uuid;
  f_eq uuid; f_ev uuid; e1 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid; rv uuid;
  n integer; s text; b bigint; r record;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';
  select id into d_tre from public.designations where name = 'Treasurer';

  ------------------------------------------------------------------ seed
  insert into public.invites (code, tier_id)
  select 'trefake00000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 16) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm, 'adm@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"trefake0000000010"}'),
    (c1,    'c1@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"trefake0000000011"}'),
    (o1,    'o1@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"trefake0000000012"}'),
    (o2,    'o2@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"trefake0000000013"}'),
    (m1,    'm1@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"trefake0000000014"}'),
    (m2,    'm2@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"trefake0000000015"}'),
    (rec,   'rec@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"trefake0000000016"}');
  update public.profiles set status = 'approved', tier_id = t_mem, is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-C1' where id = c1;
  update public.profiles set tier_id = t_cmd where id = c1;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-O1' where id = o1;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-O2' where id = o2;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M1' where id = m1;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M2' where id = m2;
  update public.profiles set status = 'approved', tier_id = t_recruit, setup_complete = true, callsign = 'Fake-Rec' where id = rec;
  -- O1 is the Treasurer (designation); Command inherits manage_treasury automatically.
  insert into public.member_designations (profile_id, designation_id) values (o1, d_tre);

  ------------------------------------------------------------------ dark ship: Admin only
  select count(*) into n from public.treasury_settings;
  if n <> 1 then raise exception 'FAIL: one settings row'; end if;
  if (select member_access from public.treasury_settings) then raise exception 'FAIL: the module must ship dark (member_access false)'; end if;

  perform pg_temp.act(v_adm);
  if public.treasury_access() <> 'full' then raise exception 'FAIL: Admin is full while dark'; end if;
  f_eq := public.treasury_create_fund('Fake equipment');
  f_ev := public.treasury_create_fund('Fake event costs');
  reset role;
  foreach s in array array['c1', 'o1', 'm1', 'rec'] loop
    perform pg_temp.act(case s when 'c1' then c1 when 'o1' then o1 when 'm1' then m1 else rec end);
    if public.treasury_access() <> 'none' then raise exception 'FAIL: % must see nothing while dark', s; end if;
    if (select count(*) from public.treasury_funds) <> 0 then raise exception 'FAIL: % read funds while dark', s; end if;
    if pg_temp.try(format('select public.treasury_record(current_date, 100, %L, null, %L, %L, %L)', 'external', 'fund', f_eq, 'deposit')) <> 'not allowed'
      then raise exception 'FAIL: % wrote while dark', s; end if;
    reset role;
  end loop;

  ------------------------------------------------------------------ anon
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  if pg_temp.try('select count(*) from public.treasury_entries') = 'ok' then raise exception 'FAIL: anon read entries'; end if;
  if pg_temp.try('select count(*) from public.treasury_funds') = 'ok' then raise exception 'FAIL: anon read funds'; end if;
  if pg_temp.try('select public.treasury_balances()') = 'ok' then raise exception 'FAIL: anon read balances'; end if;
  if pg_temp.try('select public.treasury_access()') = 'ok' then raise exception 'FAIL: anon ran treasury_access'; end if;
  reset role;

  -- Only Admin flips the switch; it is logged.
  perform pg_temp.act(c1);
  if pg_temp.try('select public.set_treasury_member_access(true)') <> 'not allowed' then raise exception 'FAIL: Command flipped the switch'; end if;
  reset role;
  perform pg_temp.act(v_adm);
  perform public.set_treasury_member_access(true);
  reset role;
  select count(*) into n from public.settings_audit where event = 'treasury_member_access_changed' and detail = 'false -> true';
  if n <> 1 then raise exception 'FAIL: the switch is logged'; end if;

  ------------------------------------------------------------------ live: who can write
  perform pg_temp.act(m1);
  if public.treasury_access() <> 'own' then raise exception 'FAIL: Member is own'; end if;
  if pg_temp.try(format('select public.treasury_record(current_date, 100, %L, null, %L, %L, %L)', 'external', 'member', m1, 'deposit')) <> 'not allowed'
    then raise exception 'FAIL: Member wrote an entry'; end if;
  if pg_temp.try('select public.treasury_create_fund(''Fake sneaky'')') <> 'not allowed' then raise exception 'FAIL: Member made a fund'; end if;
  reset role;
  perform pg_temp.act(o2);
  if public.treasury_access() <> 'full' then raise exception 'FAIL: Old Guard is full (read)'; end if;
  if pg_temp.try(format('select public.treasury_record(current_date, 100, %L, null, %L, %L, %L)', 'external', 'member', m1, 'deposit')) <> 'not allowed'
    then raise exception 'FAIL: Old Guard without the Treasurer seat wrote an entry'; end if;
  reset role;

  ------------------------------------------------------------------ the Treasurer records
  perform pg_temp.act(o1);
  e1 := public.treasury_record(current_date, 10000, 'external', null, 'member', m1, 'deposit', 'Fake: sent ahead');
  e2 := public.treasury_record(current_date, 5000, 'external', null, 'member', m2, 'deposit');
  e3 := public.treasury_record(current_date, 2500, 'member', m1, 'fund', f_ev, 'transfer', 'Fake: toward event');
  e4 := public.treasury_record(current_date, 3000, 'external', null, 'fund', f_eq, 'deposit');
  e5 := public.treasury_record(current_date, 1000, 'fund', f_eq, 'fund', f_ev, 'transfer');
  reset role;
  if public.treasury_member_balance_raw(m1) <> 7500 then raise exception 'FAIL: m1 balance'; end if;
  if public.treasury_member_balance_raw(m2) <> 5000 then raise exception 'FAIL: m2 balance'; end if;
  if public.treasury_fund_balance_raw(f_ev) <> 3500 then raise exception 'FAIL: event fund balance'; end if;
  if public.treasury_fund_balance_raw(f_eq) <> 2000 then raise exception 'FAIL: equipment fund balance'; end if;

  -- Callsign snapshots and entered_by.
  select * into r from public.treasury_entries where id = e3;
  if r.from_callsign <> 'Fake-M1' or r.entered_by <> o1 or r.entered_by_callsign <> 'Fake-O1' then raise exception 'FAIL: snapshots'; end if;

  -- Validation.
  perform pg_temp.act(o1);
  foreach s in array array[
    format('select public.treasury_record(current_date, 0, %L, null, %L, %L, %L)', 'external', 'member', m1, 'deposit'),
    format('select public.treasury_record(current_date, -5, %L, null, %L, %L, %L)', 'external', 'member', m1, 'deposit'),
    format('select public.treasury_record(current_date + 30, 100, %L, null, %L, %L, %L)', 'external', 'member', m1, 'deposit'),
    format('select public.treasury_record(current_date, 100, %L, null, %L, null, %L)', 'external', 'external', 'deposit'),
    format('select public.treasury_record(current_date, 100, %L, null, %L, %L, %L)', 'external', 'member', m1, 'Bad Category'),
    format('select public.treasury_record(current_date, 100, %L, %L, %L, %L, %L)', 'member', m1, 'member', m1, 'transfer'),
    format('select public.treasury_record(current_date, 100, %L, null, %L, gen_random_uuid(), %L)', 'external', 'fund', 'deposit')
  ] loop
    if pg_temp.try(s) = 'ok' then raise exception 'FAIL: accepted invalid entry %', s; end if;
  end loop;
  reset role;

  ------------------------------------------------------------------ negative balances rejected
  perform pg_temp.act(o1);
  if pg_temp.try(format('select public.treasury_record(current_date, 7501, %L, %L, %L, null, %L)', 'member', m1, 'external', 'withdrawal')) <> 'insufficient_funds'
    then raise exception 'FAIL: overdrew a member'; end if;
  if pg_temp.try(format('select public.treasury_record(current_date, 2001, %L, %L, %L, null, %L)', 'fund', f_eq, 'external', 'withdrawal')) <> 'insufficient_funds'
    then raise exception 'FAIL: overdrew a fund'; end if;
  perform public.treasury_record(current_date, 7500, 'member', m1, 'external', null, 'withdrawal', 'Fake: returned by bank');
  reset role;
  if public.treasury_member_balance_raw(m1) <> 0 then raise exception 'FAIL: exact balance can be withdrawn'; end if;
  -- The trigger holds even for a direct insert by the table owner.
  if pg_temp.try(format($q$insert into public.treasury_entries (entry_date, amount_cents, from_kind, from_member, to_kind, category, entered_by)
                           values (current_date, 1, 'member', %L, 'external', 'withdrawal', %L)$q$, m1, o1)) <> 'insufficient_funds'
    then raise exception 'FAIL: direct insert bypassed the balance check'; end if;

  ------------------------------------------------------------------ append-only
  foreach s in array array[
    format('update public.treasury_entries set note = ''x'' where id = %L', e1),
    format('update public.treasury_entries set amount_cents = 1 where id = %L', e1),
    format('delete from public.treasury_entries where id = %L', e1),
    'truncate public.treasury_entries',
    format('delete from public.treasury_funds where id = %L', f_eq)
  ] loop
    if pg_temp.try(s) = 'ok' then raise exception 'FAIL: not immutable: %', s; end if;
  end loop;
  perform pg_temp.act(o1);
  if pg_temp.try(format('update public.treasury_entries set note = ''x'' where id = %L', e1)) = 'ok' then
    select count(*) into n from public.treasury_entries where note = 'x';
    if n <> 0 then raise exception 'FAIL: client updated an entry'; end if;
  end if;
  if pg_temp.try(format('insert into public.treasury_entries (entry_date, amount_cents, from_kind, to_kind, to_member, category, entered_by) values (current_date, 5, ''external'', ''member'', %L, ''deposit'', %L)', m1, o1)) = 'ok'
    then raise exception 'FAIL: client inserted an entry directly'; end if;
  reset role;

  ------------------------------------------------------------------ reversing entries
  perform pg_temp.act(o1);
  if pg_temp.try(format('select public.treasury_reverse(%L, %L)', e2, 'x')) <> 'bad_note' then raise exception 'FAIL: reverse needs a note'; end if;
  -- e2 (5000 deposit to m2) is unspent: reversible.
  rv := public.treasury_reverse(e2, 'Fake: entered in error');
  if pg_temp.try(format('select public.treasury_reverse(%L, %L)', e2, 'Fake: again')) <> 'already_reversed' then raise exception 'FAIL: double reversal'; end if;
  if pg_temp.try(format('select public.treasury_reverse(%L, %L)', rv, 'Fake: undo the undo')) <> 'is_reversal' then raise exception 'FAIL: reversal of a reversal'; end if;
  -- e4 deposited 3000 into equipment; 1000 left it (e5). Reversing e4 would overdraw: refused.
  if pg_temp.try(format('select public.treasury_reverse(%L, %L)', e4, 'Fake: reverse a spent deposit')) <> 'insufficient_funds'
    then raise exception 'FAIL: reversed a spent deposit'; end if;
  perform public.treasury_reverse(e5, 'Fake: undo the transfer');
  perform public.treasury_reverse(e4, 'Fake: now reversible');
  reset role;
  select * into r from public.treasury_entries where id = rv;
  if r.reverses <> e2 or r.category <> 'reversal' then raise exception 'FAIL: reversal link'; end if;
  if r.from_kind <> 'member' or r.from_member <> m2 or r.to_kind <> 'external' or r.amount_cents <> 5000 then raise exception 'FAIL: reversal must be the mirror of the original'; end if;
  if public.treasury_member_balance_raw(m2) <> 0 then raise exception 'FAIL: m2 back to zero'; end if;
  if public.treasury_fund_balance_raw(f_eq) <> 0 then raise exception 'FAIL: equipment fund back to zero'; end if;
  if pg_temp.try(format('insert into public.treasury_entries (entry_date, amount_cents, from_kind, to_kind, to_member, category, reverses, entered_by) values (current_date, 5000, ''member'', ''external'', null, ''reversal'', %L, %L)', e2, o1)) = 'ok'
    then raise exception 'FAIL: second reversal row accepted'; end if;

  ------------------------------------------------------------------ reconciliation
  perform pg_temp.act(c1);
  select * into r from public.treasury_reconcile();
  reset role;
  if not r.ok then raise exception 'FAIL: ledger does not reconcile: %', r; end if;
  if r.net_external <> r.member_total + r.fund_total then raise exception 'FAIL: identity'; end if;
  -- Raw proof straight from the table.
  select coalesce(sum(amount_cents) filter (where from_kind = 'external'), 0) - coalesce(sum(amount_cents) filter (where to_kind = 'external'), 0)
    into b from public.treasury_entries;
  if b <> r.net_external then raise exception 'FAIL: net external mismatch'; end if;
  if (select sum(balance_cents) from (select public.treasury_fund_balance_raw(id) as balance_cents from public.treasury_funds) q)
     + (select coalesce(sum(public.treasury_member_balance_raw(id)), 0) from public.profiles) <> b
    then raise exception 'FAIL: buckets do not sum to net external'; end if;

  -- A larger random-ish sequence still reconciles and never goes negative.
  perform pg_temp.act(o1);
  for n in 1..40 loop
    perform pg_temp.try(format('select public.treasury_record(current_date, %s, %L, null, %L, %L, %L)', 100 + n * 7, 'external', 'member', case when n % 2 = 0 then m1 else m2 end, 'deposit'));
    perform pg_temp.try(format('select public.treasury_record(current_date, %s, %L, %L, %L, %L, %L)', 50 + n * 3, 'member', case when n % 3 = 0 then m1 else m2 end, 'fund', f_ev, 'transfer'));
    perform pg_temp.try(format('select public.treasury_record(current_date, %s, %L, %L, %L, null, %L)', 40 + n, 'fund', f_ev, 'external', 'withdrawal'));
  end loop;
  select * into r from public.treasury_reconcile();
  reset role;
  if not r.ok then raise exception 'FAIL: bulk sequence does not reconcile'; end if;
  if exists (select 1 from public.profiles where public.treasury_member_balance_raw(id) < 0) then raise exception 'FAIL: a member went negative'; end if;
  if exists (select 1 from public.treasury_funds where public.treasury_fund_balance_raw(id) < 0) then raise exception 'FAIL: a fund went negative'; end if;

  ------------------------------------------------------------------ visibility per tier
  -- Member: only own entries and own balance.
  perform pg_temp.act(m1);
  select count(*) into n from public.treasury_entries;
  if n = 0 then raise exception 'FAIL: Member sees own entries'; end if;
  if exists (select 1 from public.treasury_entries where from_member is distinct from m1 and to_member is distinct from m1) then raise exception 'FAIL: Member saw another member''s entry'; end if;
  if public.treasury_my_balance() <> (select coalesce(sum(case when to_member = m1 then amount_cents else -amount_cents end), 0) from public.treasury_entries) then raise exception 'FAIL: own balance'; end if;
  if pg_temp.try('select * from public.treasury_balances()') <> 'not allowed' then raise exception 'FAIL: Member read all balances'; end if;
  if pg_temp.try('select * from public.treasury_reconcile()') <> 'not allowed' then raise exception 'FAIL: Member ran reconcile'; end if;
  if pg_temp.try('select * from public.treasury_settings') = 'ok' then raise exception 'FAIL: Member read settings'; end if;
  reset role;
  perform pg_temp.act(rec);
  if public.treasury_access() <> 'own' then raise exception 'FAIL: Recruit is own'; end if;
  if (select count(*) from public.treasury_entries) <> 0 then raise exception 'FAIL: Recruit with no entries sees some'; end if;
  if public.treasury_my_balance() <> 0 then raise exception 'FAIL: Recruit balance 0'; end if;
  reset role;
  -- Old Guard and Command: the full ledger with names, balances, totals.
  foreach s in array array['o2', 'c1'] loop
    perform pg_temp.act(case s when 'o2' then o2 else c1 end);
    select count(*) into n from public.treasury_entries;
    if n <> (select count(*) from public.treasury_entries where true) or n < 10 then raise exception 'FAIL: % sees the full ledger', s; end if;
    if (select count(*) from public.treasury_balances() where kind = 'fund') <> 2 then raise exception 'FAIL: % sees the coffers', s; end if;
    if not exists (select 1 from public.treasury_entries where from_callsign = 'Fake-M1') then raise exception 'FAIL: % sees names', s; end if;
    reset role;
  end loop;
  select count(*) into n from public.treasury_entries;
  perform pg_temp.act(m1);
  if (select count(*) from public.treasury_entries) >= n then raise exception 'FAIL: Member must see fewer entries than the full ledger'; end if;
  reset role;

  ------------------------------------------------------------------ funds: create, rename, unique
  perform pg_temp.act(c1);
  if pg_temp.try('select public.treasury_create_fund(''fake EQUIPMENT'')') <> 'name_taken' then raise exception 'FAIL: case-insensitive unique fund name'; end if;
  if pg_temp.try('select public.treasury_create_fund(''x'')') <> 'bad_name' then raise exception 'FAIL: short name'; end if;
  perform public.treasury_rename_fund(f_eq, 'Fake gear');
  if pg_temp.try(format('select public.treasury_rename_fund(%L, %L)', f_eq, 'Fake event costs')) <> 'name_taken' then raise exception 'FAIL: rename onto another fund'; end if;
  reset role;
  select count(*) into n from public.settings_audit where event = 'treasury_fund_renamed' and detail = 'Fake equipment -> Fake gear';
  if n <> 1 then raise exception 'FAIL: rename is logged'; end if;
  if pg_temp.try(format('update public.treasury_funds set id = gen_random_uuid() where id = %L', f_eq)) <> 'ok'
     or not exists (select 1 from public.treasury_funds where id = f_eq) then raise exception 'FAIL: fund identity is kept'; end if;

  ------------------------------------------------------------------ a removed member's entries survive hard delete
  select count(*) into n from public.treasury_entries where from_member = m2 or to_member = m2;
  delete from auth.users where id = m2;
  if (select count(*) from public.treasury_entries where from_member = m2 or to_member = m2) <> n then raise exception 'FAIL: entries outlive the member'; end if;

  raise notice 'treasury ledger: ALL PASS';
end;
$$;

rollback;
