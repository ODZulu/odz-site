-- Tier 1 database tests for MVA-217: treasury requests (donate, refund, approval threshold).
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

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
  c1 uuid := '00000000-0000-0000-0000-0000000000c1';   -- Command (approver)
  c2 uuid := '00000000-0000-0000-0000-0000000000c2';   -- Command, also a requester
  o1 uuid := '00000000-0000-0000-0000-0000000000b1';   -- Old Guard with the Treasurer seat
  o2 uuid := '00000000-0000-0000-0000-0000000000b2';   -- Old Guard, no seat
  m1 uuid := '00000000-0000-0000-0000-0000000000d1';
  m2 uuid := '00000000-0000-0000-0000-0000000000d2';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid; d_tre uuid;
  f_eq uuid; q1 uuid; q2 uuid; q3 uuid; q4 uuid; q5 uuid;
  n integer; s text; r record; b bigint;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';
  select id into d_tre from public.designations where name = 'Treasurer';

  insert into public.invites (code, tier_id)
  select 'tqfake00000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 16) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm, 'adm@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"tqfake0000000010"}'),
    (c1,    'c1@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"tqfake0000000011"}'),
    (c2,    'c2@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"tqfake0000000012"}'),
    (o1,    'o1@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"tqfake0000000013"}'),
    (o2,    'o2@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"tqfake0000000014"}'),
    (m1,    'm1@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"tqfake0000000015"}'),
    (m2,    'm2@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"tqfake0000000016"}');
  update public.profiles set status = 'approved', tier_id = t_mem, is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-C1' where id = c1;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-C2' where id = c2;
  update public.profiles set tier_id = t_cmd where id in (c1, c2);
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-O1' where id = o1;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-O2' where id = o2;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M1' where id = m1;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-M2' where id = m2;
  insert into public.member_designations (profile_id, designation_id) values (o1, d_tre);

  -- Go live for the test (the ledger module ships dark).
  update public.treasury_settings set member_access = true;
  f_eq := (select id from public.treasury_funds limit 1);
  if f_eq is null then
    insert into public.treasury_funds (name) values ('Fake coffers') returning id into f_eq;
  end if;
  insert into public.treasury_entries (entry_date, amount_cents, from_kind, to_kind, to_member, category, entered_by)
  values (current_date, 10000, 'external', 'member', m1, 'deposit', o1),
         (current_date, 13000, 'external', 'member', m2, 'deposit', o1),
         (current_date, 500000, 'external', 'member', c2, 'deposit', o1);

  if (select approval_threshold_cents from public.treasury_settings) <> 0 then raise exception 'FAIL: threshold defaults to 0'; end if;

  ------------------------------------------------------------------ threshold: Command or Admin only
  perform pg_temp.act(o1);
  if pg_temp.try('select public.set_treasury_approval_threshold(5000)') <> 'not allowed' then raise exception 'FAIL: Treasurer set the threshold'; end if;
  reset role;
  perform pg_temp.act(m1);
  if pg_temp.try('select public.set_treasury_approval_threshold(5000)') <> 'not allowed' then raise exception 'FAIL: Member set the threshold'; end if;
  if pg_temp.try('update public.treasury_settings set approval_threshold_cents = 1') = 'ok' then raise exception 'FAIL: client wrote the settings row'; end if;
  reset role;
  perform pg_temp.act(c1);
  if pg_temp.try('select public.set_treasury_approval_threshold(-1)') <> 'bad_amount' then raise exception 'FAIL: negative threshold'; end if;
  perform public.set_treasury_approval_threshold(5000);
  if public.treasury_threshold() <> 5000 then raise exception 'FAIL: threshold read'; end if;
  reset role;
  select count(*) into n from public.settings_audit where event = 'treasury_threshold_changed' and detail = '0 -> 5000 cents';
  if n <> 1 then raise exception 'FAIL: threshold change is logged'; end if;

  ------------------------------------------------------------------ donation: immediate, limited to available
  perform pg_temp.act(m1);
  if public.treasury_my_available() <> 10000 then raise exception 'FAIL: m1 available'; end if;
  perform public.treasury_donate(f_eq, 1500, 'Fake gift');
  if pg_temp.try(format('select public.treasury_donate(%L, 8501)', f_eq)) <> 'insufficient_funds' then raise exception 'FAIL: donated more than available'; end if;
  if pg_temp.try(format('select public.treasury_donate(%L, 0)', f_eq)) <> 'bad_amount' then raise exception 'FAIL: zero donation'; end if;
  if pg_temp.try('select public.treasury_donate(gen_random_uuid(), 100)') <> 'not_found' then raise exception 'FAIL: unknown fund'; end if;
  reset role;
  select * into r from public.treasury_entries where category = 'donation' and from_member = m1;
  if r.amount_cents <> 1500 or r.to_fund <> f_eq or r.entered_by <> m1 or r.to_kind <> 'fund' then raise exception 'FAIL: donation entry'; end if;
  if public.treasury_member_balance_raw(m1) <> 8500 then raise exception 'FAIL: balance after donation'; end if;

  ------------------------------------------------------------------ refund request reserves
  perform pg_temp.act(m1);
  q1 := public.treasury_request_refund(3000, 'Fake: event cancelled');
  if public.treasury_my_available() <> 5500 then raise exception 'FAIL: reservation reduces available (got %)', public.treasury_my_available(); end if;
  if pg_temp.try('select public.treasury_request_refund(5501, ''Fake too much'')') <> 'insufficient_funds' then raise exception 'FAIL: double request beyond available'; end if;
  if pg_temp.try(format('select public.treasury_donate(%L, 5501)', f_eq)) <> 'insufficient_funds' then raise exception 'FAIL: donated reserved money'; end if;
  if pg_temp.try('select public.treasury_request_refund(100, ''x'')') <> 'bad_note' then raise exception 'FAIL: note required'; end if;
  perform public.treasury_donate(f_eq, 5500);   -- exactly what is available
  if public.treasury_my_available() <> 0 then raise exception 'FAIL: nothing available'; end if;
  if pg_temp.try('select public.treasury_request_refund(1, ''Fake nothing left'')') <> 'insufficient_funds' then raise exception 'FAIL: requested with nothing available'; end if;
  reset role;
  select * into r from public.treasury_requests where id = q1;
  if r.status <> 'pending' or r.needs_approval or r.threshold_at_submit <> 5000 or r.requester <> m1 or r.requester_callsign <> 'Fake-M1' then
    raise exception 'FAIL: request row (3000 <= 5000 needs no approval)';
  end if;

  -- The reservation holds against a Treasurer transfer and a direct insert too.
  perform pg_temp.act(o1);
  if pg_temp.try(format('select public.treasury_record(current_date, 1, %L, %L, %L, null, %L)', 'member', m1, 'external', 'withdrawal')) <> 'insufficient_funds'
    then raise exception 'FAIL: Treasurer spent reserved money'; end if;
  reset role;
  if pg_temp.try(format($q$insert into public.treasury_entries (entry_date, amount_cents, from_kind, from_member, to_kind, category, entered_by)
                           values (current_date, 1, 'member', %L, 'external', 'withdrawal', %L)$q$, m1, o1)) <> 'insufficient_funds'
    then raise exception 'FAIL: direct insert spent reserved money'; end if;

  ------------------------------------------------------------------ visibility
  perform pg_temp.act(m2);
  if (select count(*) from public.treasury_requests) <> 0 then raise exception 'FAIL: m2 sees m1''s request'; end if;
  if (select count(*) from public.treasury_request_log) <> 0 then raise exception 'FAIL: m2 sees m1''s request log'; end if;
  reset role;
  perform pg_temp.act(m1);
  if (select count(*) from public.treasury_requests) <> 1 or (select count(*) from public.treasury_request_log) <> 1 then raise exception 'FAIL: requester sees own request and log'; end if;
  reset role;
  foreach s in array array['o2', 'c1', 'o1'] loop
    perform pg_temp.act(case s when 'o2' then o2 when 'c1' then c1 else o1 end);
    if (select count(*) from public.treasury_requests where id = q1) <> 1 then raise exception 'FAIL: % sees the request', s; end if;
    reset role;
  end loop;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  if pg_temp.try('select count(*) from public.treasury_requests') = 'ok' then raise exception 'FAIL: anon read requests'; end if;
  if pg_temp.try('select public.treasury_request_refund(100, ''Fake anon'')') = 'ok' then raise exception 'FAIL: anon requested'; end if;
  if pg_temp.try(format('select public.treasury_donate(%L, 100)', f_eq)) = 'ok' then raise exception 'FAIL: anon donated'; end if;
  reset role;

  ------------------------------------------------------------------ client cannot write the tables
  perform pg_temp.act(m1);
  if pg_temp.try(format('update public.treasury_requests set status = ''paid'', paid_date = current_date where id = %L', q1)) = 'ok'
     and (select status from public.treasury_requests where id = q1) <> 'pending' then raise exception 'FAIL: client paid own request'; end if;
  if pg_temp.try(format('insert into public.treasury_requests (requester, amount_cents, note, needs_approval, threshold_at_submit) values (%L, 1, ''Fake note'', false, 0)', m1)) = 'ok'
    then raise exception 'FAIL: client inserted a request'; end if;
  reset role;

  ------------------------------------------------------------------ pay: Treasurer, at or below the threshold
  perform pg_temp.act(m2);
  if pg_temp.try(format('select public.treasury_pay_request(%L, current_date, %L)', q1, 'Fake ref')) <> 'not allowed' then raise exception 'FAIL: Member paid'; end if;
  if pg_temp.try(format('select public.treasury_reject_request(%L, %L)', q1, 'Fake no')) <> 'not allowed' then raise exception 'FAIL: Member rejected'; end if;
  if pg_temp.try(format('select public.treasury_cancel_request(%L)', q1)) <> 'not_found' then raise exception 'FAIL: cancelled another member''s request'; end if;
  reset role;
  perform pg_temp.act(o2);
  if pg_temp.try(format('select public.treasury_pay_request(%L, current_date, %L)', q1, 'Fake ref')) <> 'not allowed' then raise exception 'FAIL: Old Guard without the seat paid'; end if;
  reset role;
  perform pg_temp.act(o1);
  if pg_temp.try(format('select public.treasury_approve_request(%L)', q1)) <> 'not allowed' then raise exception 'FAIL: Treasurer (not Command) approved'; end if;
  if pg_temp.try(format('select public.treasury_pay_request(%L, current_date + 30, %L)', q1, 'Fake ref')) <> 'bad_date' then raise exception 'FAIL: future payment date'; end if;
  q5 := public.treasury_pay_request(q1, current_date, 'Fake: bank ref 0001');
  reset role;
  select * into r from public.treasury_requests where id = q1;
  if r.status <> 'paid' or r.paid_date <> current_date or r.paid_reference <> 'Fake: bank ref 0001' or r.decided_by <> o1 then raise exception 'FAIL: paid row'; end if;
  select * into r from public.treasury_entries where id = q5;
  if r.from_kind <> 'member' or r.from_member <> m1 or r.to_kind <> 'external' or r.amount_cents <> 3000 or r.category <> 'refund' or r.request_id <> q1
    then raise exception 'FAIL: payout entry'; end if;
  if public.treasury_member_balance_raw(m1) <> 0 then raise exception 'FAIL: balance after payout'; end if;
  perform pg_temp.act(o1);
  if pg_temp.try(format('select public.treasury_pay_request(%L, current_date, %L)', q1, 'again')) <> 'not_pending' then raise exception 'FAIL: paid twice'; end if;
  if pg_temp.try(format('select public.treasury_reject_request(%L, %L)', q1, 'Fake late')) <> 'not_pending' then raise exception 'FAIL: rejected a paid request'; end if;
  reset role;
  perform pg_temp.act(m1);
  if pg_temp.try(format('select public.treasury_cancel_request(%L)', q1)) <> 'not_pending' then raise exception 'FAIL: cancelled a paid request'; end if;
  reset role;
  select count(*) into n from public.treasury_request_log where request_id = q1;
  if n <> 2 then raise exception 'FAIL: log has requested and paid (got %)', n; end if;

  ------------------------------------------------------------------ above the threshold: Command approves first
  perform pg_temp.act(m2);
  q2 := public.treasury_request_refund(6000, 'Fake: large refund');
  reset role;
  if not (select needs_approval from public.treasury_requests where id = q2) then raise exception 'FAIL: 6000 > 5000 needs approval'; end if;
  perform pg_temp.act(m2);
  q3 := public.treasury_request_refund(5000, 'Fake: exactly the limit');
  reset role;
  if (select needs_approval from public.treasury_requests where id = q3) then raise exception 'FAIL: exactly the threshold needs no approval'; end if;

  perform pg_temp.act(o1);
  if pg_temp.try(format('select public.treasury_pay_request(%L, current_date, %L)', q2, 'Fake ref')) <> 'needs_approval' then raise exception 'FAIL: paid without approval'; end if;
  if pg_temp.try(format('select public.treasury_approve_request(%L)', q3)) <> 'not allowed' then raise exception 'FAIL: Treasurer approve gate'; end if;
  reset role;
  perform pg_temp.act(c1);
  if pg_temp.try(format('select public.treasury_approve_request(%L)', q3)) <> 'no_approval_needed' then raise exception 'FAIL: approved one that needs none'; end if;
  perform public.treasury_approve_request(q2);
  if pg_temp.try(format('select public.treasury_approve_request(%L)', q2)) <> 'already_approved' then raise exception 'FAIL: approved twice'; end if;
  reset role;
  select * into r from public.treasury_requests where id = q2;
  if r.approved_by <> c1 or r.approved_callsign <> 'Fake-C1' or r.status <> 'pending' then raise exception 'FAIL: approval recorded'; end if;
  -- A later threshold change does not reclassify requests in flight.
  perform pg_temp.act(c1);
  perform public.set_treasury_approval_threshold(100000);
  reset role;
  if not (select needs_approval from public.treasury_requests where id = q2) then raise exception 'FAIL: frozen needs_approval'; end if;
  perform pg_temp.act(o1);
  perform public.treasury_pay_request(q2, current_date, 'Fake ref 2');
  reset role;
  if (select status from public.treasury_requests where id = q2) <> 'paid' then raise exception 'FAIL: approved request paid'; end if;

  ------------------------------------------------------------------ approver cannot be the requester
  perform pg_temp.act(c2);
  q4 := public.treasury_request_refund(200000, 'Fake: Command member asks for a large refund');
  reset role;
  if not (select needs_approval from public.treasury_requests where id = q4) then raise exception 'FAIL: 200000 needs approval'; end if;
  perform pg_temp.act(c2);
  if pg_temp.try(format('select public.treasury_approve_request(%L)', q4)) <> 'own_request' then raise exception 'FAIL: approved own request'; end if;
  if pg_temp.try(format('select public.treasury_pay_request(%L, current_date, %L)', q4, 'x')) <> 'own_request' then raise exception 'FAIL: paid own request'; end if;
  if pg_temp.try(format('select public.treasury_reject_request(%L, %L)', q4, 'Fake mine')) <> 'own_request' then raise exception 'FAIL: rejected own request'; end if;
  reset role;
  perform pg_temp.act(v_adm);
  perform public.treasury_approve_request(q4);   -- another approver (Admin) may
  reset role;

  ------------------------------------------------------------------ reject frees the reservation; cancel does too
  perform pg_temp.act(o1);
  if pg_temp.try(format('select public.treasury_reject_request(%L, %L)', q3, 'no')) <> 'bad_note' then raise exception 'FAIL: reject needs a reason'; end if;
  perform public.treasury_reject_request(q3, 'Fake: not enough documentation');
  reset role;
  select * into r from public.treasury_requests where id = q3;
  if r.status <> 'rejected' or r.decision_note <> 'Fake: not enough documentation' or r.decided_by <> o1 then raise exception 'FAIL: rejected row'; end if;
  perform pg_temp.act(m2);
  if public.treasury_my_available() <> 7000 then raise exception 'FAIL: reservation released on reject (got %)', public.treasury_my_available(); end if;
  q3 := public.treasury_request_refund(2000, 'Fake: again, smaller');
  perform public.treasury_cancel_request(q3);
  if public.treasury_my_available() <> 7000 then raise exception 'FAIL: reservation released on cancel'; end if;
  reset role;
  select count(*) into n from public.treasury_request_log where request_id = q3 and action in ('requested', 'cancelled');
  if n <> 2 then raise exception 'FAIL: cancel logged'; end if;

  ------------------------------------------------------------------ log is append-only; requests never deleted; one payout each
  foreach s in array array[
    'update public.treasury_request_log set note = ''x''',
    'delete from public.treasury_request_log',
    'truncate public.treasury_request_log',
    format('delete from public.treasury_requests where id = %L', q1),
    format('update public.treasury_requests set amount_cents = 1 where id = %L', q4),
    format('update public.treasury_requests set status = ''pending'' where id = %L', q1),
    format($q$insert into public.treasury_entries (entry_date, amount_cents, from_kind, from_member, to_kind, category, request_id, entered_by)
              values (current_date, 1, 'external', null, 'member', 'deposit', %L, %L)$q$, q1, o1)
  ] loop
    if pg_temp.try(s) = 'ok' then raise exception 'FAIL: allowed %', s; end if;
  end loop;

  ------------------------------------------------------------------ the ledger still reconciles
  perform pg_temp.act(c1);
  select * into r from public.treasury_reconcile();
  reset role;
  if not r.ok then raise exception 'FAIL: ledger does not reconcile: %', r; end if;

  ------------------------------------------------------------------ dark ship still applies to every new function
  update public.treasury_settings set member_access = false;
  perform pg_temp.act(m2);
  if public.treasury_my_available() is not null then raise exception 'FAIL: available visible while dark'; end if;
  if pg_temp.try(format('select public.treasury_donate(%L, 100)', f_eq)) <> 'not allowed' then raise exception 'FAIL: donated while dark'; end if;
  if pg_temp.try('select public.treasury_request_refund(100, ''Fake dark'')') <> 'not allowed' then raise exception 'FAIL: requested while dark'; end if;
  if (select count(*) from public.treasury_requests) <> 0 then raise exception 'FAIL: read requests while dark'; end if;
  reset role;
  perform pg_temp.act(c1);
  if pg_temp.try('select public.set_treasury_approval_threshold(1)') <> 'not allowed' then raise exception 'FAIL: Command set threshold while dark'; end if;
  reset role;

  raise notice 'treasury requests: ALL PASS';
end;
$$;

rollback;
