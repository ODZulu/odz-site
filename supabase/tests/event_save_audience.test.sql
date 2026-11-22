-- Tier 1 database tests for MVA-303: save_event writes the event and its audience in one call.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

create function pg_temp.act(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

create function pg_temp.fails(q text, expected text default null) returns void language plpgsql as $$
begin
  begin
    execute q;
  exception when others then
    if expected is not null and sqlerrm <> expected then
      raise exception 'FAIL: "%" raised "%" not "%"', q, sqlerrm, expected;
    end if;
    return;
  end;
  raise exception 'FAIL: expected an error from %', q;
end $$;

do $$
declare
  v_cmd uuid := '00000000-0000-0000-0000-0000000000f1';
  v_mem uuid := '00000000-0000-0000-0000-0000000000f2';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  ev uuid; ev_pub uuid;
  n integer;
  a text;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  insert into public.invites (code, tier_id)
  select 'safake000000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 11) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_cmd, 'cmd@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"safake00000000010"}'),
    (v_mem, 'mem@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"safake00000000011"}');
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;

  ------------------------------------------------------------------ the dev-only forms are gone; the 8-argument form stays for prod
  if to_regprocedure('public.event_set_audience(uuid, text)') is not null then
    raise exception 'FAIL: event_set_audience should be removed';
  end if;
  if to_regprocedure('public.save_event(uuid, text, text, timestamptz, timestamptz, text, text, text, numeric, numeric, boolean, text)') is not null then
    raise exception 'FAIL: the 12-argument save_event should be removed';
  end if;
  -- The live prod app calls the 8-argument form until the release reaches main (dropped later in MVA-304).
  if to_regprocedure('public.save_event(uuid, text, text, timestamptz, timestamptz, text, text, text)') is null then
    raise exception 'FAIL: the 8-argument save_event must stay until the release is live';
  end if;

  ------------------------------------------------------------------ a Command-only event is restricted from its first moment
  perform pg_temp.act(v_cmd);
  ev := public.save_event(null, 'Fake Command Only', 'Meeting', now() + interval '3 days', null, null, null, null, null, null, false, null, 'command');
  reset role;
  select audience into a from public.events where id = ev;
  if a is distinct from 'command' then raise exception 'FAIL: audience not stored with the event (got %)', a; end if;

  perform pg_temp.act(v_mem);
  select count(*) into n from public.events where id = ev;
  if n <> 0 then raise exception 'FAIL: a Member can read a Command-only event after a successful save'; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  select count(*) into n from public.events where id = ev;
  if n <> 0 then raise exception 'FAIL: anon can read a Command-only event after a successful save'; end if;
  reset role;

  ------------------------------------------------------------------ no audience, or a bad one: rejected, and no event is left behind
  perform pg_temp.act(v_cmd);
  perform pg_temp.fails($q$select public.save_event(null, 'Fake No Audience', 'Meeting', now() + interval '3 days', null, null, null, null, null, null, false, null, null)$q$, 'invalid_audience');
  perform pg_temp.fails($q$select public.save_event(null, 'Fake Bad Audience', 'Meeting', now() + interval '3 days', null, null, null, null, null, null, false, null, 'everyone')$q$, 'invalid_audience');
  reset role;
  select count(*) into n from public.events where title in ('Fake No Audience', 'Fake Bad Audience');
  if n <> 0 then raise exception 'FAIL: a rejected save left % event(s) behind', n; end if;

  ------------------------------------------------------------------ an explicit public event is stored as null and everyone sees it
  perform pg_temp.act(v_cmd);
  ev_pub := public.save_event(null, 'Fake Public Event', 'Other', now() + interval '3 days', null, null, null, null, null, null, false, null, 'public');
  reset role;
  select audience into a from public.events where id = ev_pub;
  if a is not null then raise exception 'FAIL: public should be stored as null (got %)', a; end if;
  perform pg_temp.act(v_mem);
  select count(*) into n from public.events where id = ev_pub;
  if n <> 1 then raise exception 'FAIL: a Member should see a public event'; end if;
  reset role;

  ------------------------------------------------------------------ updating: null keeps the audience, a value changes it
  perform pg_temp.act(v_cmd);
  perform public.save_event(ev, 'Fake Command Only Renamed', 'Meeting', now() + interval '3 days', null, null, null, null, null, null, false, null, null);
  reset role;
  select audience into a from public.events where id = ev;
  if a is distinct from 'command' then raise exception 'FAIL: an update with no audience changed it to %', a; end if;

  perform pg_temp.act(v_cmd);
  perform pg_temp.fails(format('select public.save_event(%L, ''x'', ''Meeting'', now() + interval ''3 days'', null, null, null, null, null, null, false, null, ''everyone'')', ev), 'invalid_audience');
  reset role;
  select audience into a from public.events where id = ev;
  if a is distinct from 'command' then raise exception 'FAIL: a rejected update changed the audience to %', a; end if;

  perform pg_temp.act(v_cmd);
  perform public.save_event(ev, 'Fake Command Only Renamed', 'Meeting', now() + interval '3 days', null, null, null, null, null, null, false, null, 'members');
  reset role;
  select audience into a from public.events where id = ev;
  if a is distinct from 'members' then raise exception 'FAIL: audience not updated (got %)', a; end if;

  perform pg_temp.act(v_cmd);
  perform public.save_event(ev, 'Fake Command Only Renamed', 'Meeting', now() + interval '3 days', null, null, null, null, null, null, false, null, 'public');
  reset role;
  select audience into a from public.events where id = ev;
  if a is not null then raise exception 'FAIL: public did not clear the audience (got %)', a; end if;

  ------------------------------------------------------------------ the 8-argument form still behaves as prod expects
  perform pg_temp.act(v_cmd);
  ev_pub := public.save_event(null, 'Fake Prod Form Event', 'Other', now() + interval '4 days', null, 'Fake Spot', null, null);
  reset role;
  select audience into a from public.events where id = ev_pub;
  if a is not null then raise exception 'FAIL: 8-argument create should be public, as in prod (got %)', a; end if;
  perform pg_temp.act(v_cmd);
  perform public.save_event(ev_pub, 'Fake Prod Form Event Two', 'Other', now() + interval '4 days', null, 'Fake Spot', null, null);
  reset role;
  if not exists (select 1 from public.events where id = ev_pub and title = 'Fake Prod Form Event Two') then
    raise exception 'FAIL: 8-argument update did not apply';
  end if;

  ------------------------------------------------------------------ who may save is unchanged
  perform pg_temp.act(v_mem);
  perform pg_temp.fails(format('select public.save_event(null, ''Fake Member Event'', ''Other'', now() + interval ''3 days'', null, null, null, null, null, null, false, null, ''public'')'));
  perform pg_temp.fails(format('select public.save_event(%L, ''Hijack'', ''Other'', now() + interval ''3 days'', null, null, null, null, null, null, false, null, ''command'')', ev_pub), 'not allowed');
  reset role;
  select count(*) into n from public.events where title = 'Fake Member Event';
  if n <> 0 then raise exception 'FAIL: a Member created an event'; end if;

  raise notice 'event_save_audience: ALL PASS';
end $$;

rollback;
