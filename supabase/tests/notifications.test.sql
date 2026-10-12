-- Tier 1 database tests for MVA-203 Phase A: reminder windows and idempotency, event-change
-- notifications, preferences, subscriptions, the push claim, and who can see what.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_cmd uuid := '00000000-0000-0000-0000-0000000000c1';
  v_mem uuid := '00000000-0000-0000-0000-0000000000b1';
  v_late uuid := '00000000-0000-0000-0000-0000000000b2';
  v_rec uuid := '00000000-0000-0000-0000-0000000000f1';
  v_pend uuid := '00000000-0000-0000-0000-0000000000d1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  ev uuid; ev2 uuid; ev3 uuid; ev4 uuid;
  s1 timestamptz := date_trunc('minute', now()) + interval '3 days';
  s2 timestamptz := date_trunc('minute', now()) + interval '4 days';
  s3 timestamptz := date_trunc('minute', now()) + interval '5 days';
  made integer;
  n integer;
  sub_id uuid;
  r record;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  insert into public.invites (code, tier_id)
  select 'ntfake00000000' || g, t_recruit from generate_series(10, 14) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_cmd,  'cmd@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"ntfake0000000010"}'),
    (v_mem,  'mem@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"ntfake0000000011"}'),
    (v_late, 'late@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"ntfake0000000012"}'),
    (v_rec,  'rec@example.invalid',  'authenticated', 'authenticated', '{"invite_code":"ntfake0000000013"}'),
    (v_pend, 'pend@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"ntfake0000000014"}');
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Late' where id = v_late;
  update public.profiles set status = 'approved', setup_complete = true, callsign = 'Fake-Rec' where id = v_rec;

  ------------------------------------------------------------------ helpers
  if public.phoenix_stamp(timestamptz '2026-10-10 13:30:00+00') <> '10 OCT 2026 0630L' then
    raise exception 'FAIL: phoenix_stamp gave %', public.phoenix_stamp(timestamptz '2026-10-10 13:30:00+00');
  end if;
  select count(*) into n from public.event_recipients();
  if n <> 3 then raise exception 'FAIL: recipients should be cmd, mem and late (got %)', n; end if;
  select count(*) into n from public.event_recipients() x where x.profile_id in (v_rec, v_pend);
  if n <> 0 then raise exception 'FAIL: recruit and pending must not be recipients'; end if;

  ------------------------------------------------------------------ new event -> 'new' notifications
  insert into public.events (title, starts_at) values ('Fake Op', s1) returning id into ev;
  insert into public.event_details (event_id, location_name, location_detail, description)
  values (ev, 'Fake Secret Spot', 'Fake secret directions', 'Fake secret description');
  select count(*) into n from public.notifications where kind = 'new' and title = 'Fake Op';
  if n <> 3 then raise exception 'FAIL: new event should notify the 3 recipients (got %)', n; end if;
  select count(*) into n from public.notifications where body !~ ('Starts ' || public.phoenix_stamp(s1)) and kind = 'new';
  if n <> 0 then raise exception 'FAIL: new-event body should carry the time'; end if;

  ------------------------------------------------------------------ reminder windows
  -- 24h lead: due from start-24h for 15 minutes.
  made := public.generate_reminders(s1 - interval '1 day' - interval '1 minute');
  if made <> 0 then raise exception 'FAIL: reminder fired before its window (made %)', made; end if;
  made := public.generate_reminders(s1 - interval '1 day' + interval '2 minutes');
  if made <> 3 then raise exception 'FAIL: expected 3 reminders at 24h (got %)', made; end if;
  made := public.generate_reminders(s1 - interval '1 day' + interval '2 minutes');
  if made <> 0 then raise exception 'FAIL: reminder repeated (got %)', made; end if;
  made := public.generate_reminders(s1 - interval '1 day' + interval '9 minutes');
  if made <> 0 then raise exception 'FAIL: reminder repeated inside the window (got %)', made; end if;
  made := public.generate_reminders(s1 - interval '1 day' + interval '16 minutes');
  if made <> 0 then raise exception 'FAIL: reminder fired after its window (got %)', made; end if;
  -- 2h lead (the default second lead).
  made := public.generate_reminders(s1 - interval '2 hours' + interval '1 minute');
  if made <> 3 then raise exception 'FAIL: expected 3 reminders at 2h (got %)', made; end if;
  -- Never after the start.
  made := public.generate_reminders(s1 + interval '1 minute');
  if made <> 0 then raise exception 'FAIL: reminder fired after the event started'; end if;
  select count(*) into n from public.reminder_log where event_id = ev;
  if n <> 6 then raise exception 'FAIL: reminder_log should hold 6 rows (got %)', n; end if;

  -- Payload: title and time only. No location, directions or description anywhere.
  select count(*) into n from public.notifications where title || ' ' || body ~* 'secret|spot|directions|description';
  if n <> 0 then raise exception 'FAIL: a notification leaked event details'; end if;
  select count(*) into n from public.notifications where kind = 'reminder' and profile_id in (v_rec, v_pend);
  if n <> 0 then raise exception 'FAIL: reminders went to someone without event access'; end if;

  ------------------------------------------------------------------ custom lead times
  insert into public.notification_prefs (profile_id, push_enabled, lead_minutes) values (v_mem, true, '{30}');
  insert into public.events (title, starts_at) values ('Fake Training', s2) returning id into ev2;
  made := public.generate_reminders(s2 - interval '1 day' + interval '1 minute');
  if made <> 2 then raise exception 'FAIL: member with only a 30 minute lead should not get the 24h reminder (made %)', made; end if;
  made := public.generate_reminders(s2 - interval '30 minutes' + interval '1 minute');
  if made <> 1 then raise exception 'FAIL: expected only the 30 minute reminder (made %)', made; end if;
  select count(*) into n from public.notifications where profile_id = v_mem and kind = 'reminder' and title = 'Fake Training';
  if n <> 1 then raise exception 'FAIL: member should have exactly their own lead (got %)', n; end if;

  -- An event created close to its start never fires a reminder for a window already gone.
  insert into public.events (title, starts_at) values ('Fake Short Notice', s3) returning id into ev3;
  made := public.generate_reminders(s3 - interval '3 hours');
  if made <> 0 then raise exception 'FAIL: late-created event fired a stale reminder (made %)', made; end if;

  -- Cancelled events get no reminders.
  insert into public.events (title, starts_at, status) values ('Fake Cancelled', s3, 'cancelled') returning id into ev4;
  made := public.generate_reminders(s3 - interval '1 day' + interval '1 minute');
  select count(*) into n from public.notifications where title = 'Fake Cancelled' and kind = 'reminder';
  if n <> 0 then raise exception 'FAIL: reminder for a cancelled event'; end if;

  ------------------------------------------------------------------ cancel and move -> notifications (actor excluded)
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.events set status = 'cancelled' where id = ev2;
  reset role;
  select count(*) into n from public.notifications where kind = 'cancelled' and title = 'Fake Training';
  if n <> 2 then raise exception 'FAIL: cancellation should notify the 2 other members (got %)', n; end if;
  select count(*) into n from public.notifications where kind = 'cancelled' and profile_id = v_cmd;
  if n <> 0 then raise exception 'FAIL: the actor was notified of their own change'; end if;

  set local role authenticated;
  update public.events set starts_at = s1 + interval '1 day' where id = ev;
  reset role;
  select count(*) into n from public.notifications where kind = 'changed' and title = 'Fake Op';
  if n <> 2 then raise exception 'FAIL: time change should notify the 2 other members (got %)', n; end if;
  select count(*) into n from public.reminder_log where event_id = ev;
  if n <> 0 then raise exception 'FAIL: a moved event should get fresh reminder windows'; end if;
  made := public.generate_reminders(s1 + interval '1 day' - interval '1 day' + interval '2 minutes');
  -- cmd and late use the default leads; mem chose only a 30 minute lead.
  if made <> 2 then raise exception 'FAIL: moved event did not remind at its new time (made %)', made; end if;

  perform set_config('request.jwt.claims', '', true);

  ------------------------------------------------------------------ notifications: owner only
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.notifications where profile_id <> v_mem;
  if n <> 0 then raise exception 'FAIL: member read another member''s notifications'; end if;
  select count(*) into n from public.notifications;
  if n < 3 then raise exception 'FAIL: member should read their own notifications (got %)', n; end if;
  update public.notifications set read_at = now() where read_at is null;
  select count(*) into n from public.notifications where read_at is null;
  if n <> 0 then raise exception 'FAIL: mark-all-read failed'; end if;
  begin update public.notifications set title = 'hacked'; raise exception 'FAIL: notification title editable';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.notifications (profile_id, kind, title, body) values (v_mem, 'test', 'x', 'y'); raise exception 'FAIL: client inserted a notification';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  update public.notifications set read_at = null where profile_id <> v_mem;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: touched another member''s notification'; end if;

  ------------------------------------------------------------------ preferences
  select count(*) into n from public.notification_prefs; if n <> 1 then raise exception 'FAIL: member should see only their own prefs'; end if;
  update public.notification_prefs set lead_minutes = '{1440,720,120,30}', push_enabled = true;
  begin update public.notification_prefs set lead_minutes = '{45}'; raise exception 'FAIL: non-preset lead accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin update public.notification_prefs set lead_minutes = '{}'; raise exception 'FAIL: empty lead list accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.notification_prefs (profile_id, push_enabled) values (v_late, true); raise exception 'FAIL: wrote someone else''s prefs';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ subscriptions
  perform public.register_push_subscription('https://fcm.googleapis.com/fcm/send/fake-one', 'fake-p256dh-key-abcdefghij', 'fake-auth-0123', 'Fake Browser');
  begin perform public.register_push_subscription('https://evil.example.invalid/push', 'fake-p256dh-key-abcdefghij', 'fake-auth-0123'); raise exception 'FAIL: a non-push-service endpoint was accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  select count(*) into n from public.push_subscriptions; if n <> 1 then raise exception 'FAIL: own subscription missing'; end if;
  begin perform p256dh from public.push_subscriptions; raise exception 'FAIL: client can read subscription keys';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform auth from public.push_subscriptions; raise exception 'FAIL: client can read the auth secret';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://fcm.googleapis.com/fcm/send/direct', 'fake-p256dh-key-abcdefghij', 'fake-auth-0123'); raise exception 'FAIL: direct subscription insert';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- Test notification: once a minute.
  perform public.send_test_notification();
  begin perform public.send_test_notification(); raise exception 'FAIL: test notification not rate limited';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'too_soon' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;

  -- A device that moves to another account changes owner; the first account no longer sees it.
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_late, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.register_push_subscription('https://fcm.googleapis.com/fcm/send/fake-one', 'fake-p256dh-key-abcdefghij', 'fake-auth-0123', 'Fake Browser');
  select count(*) into n from public.push_subscriptions; if n <> 1 then raise exception 'FAIL: device did not move to the new account'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.push_subscriptions; if n <> 0 then raise exception 'FAIL: previous owner still sees the device'; end if;
  perform public.register_push_subscription('https://fcm.googleapis.com/fcm/send/fake-two', 'fake-p256dh-key-abcdefghij', 'fake-auth-0123', 'Fake Browser');

  ------------------------------------------------------------------ pending and anon
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pend, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.register_push_subscription('https://fcm.googleapis.com/fcm/send/fake-p', 'fake-p256dh-key-abcdefghij', 'fake-auth-0123'); raise exception 'FAIL: pending registered a device';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.send_test_notification(); raise exception 'FAIL: pending sent a test notification';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.claim_pushes(); raise exception 'FAIL: a client called claim_pushes';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.generate_reminders(); raise exception 'FAIL: a client called generate_reminders';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform 1 from public.notifications; raise exception 'FAIL: anon read notifications';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform 1 from public.push_subscriptions; raise exception 'FAIL: anon read subscriptions';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform 1 from public.reminder_log; raise exception 'FAIL: anon read the reminder log';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  ------------------------------------------------------------------ the push claim (service side)
  -- Only members with push enabled and a subscription come back; everything is marked sent.
  select count(*) into n from public.notifications where push_sent_at is null;
  if n = 0 then raise exception 'FAIL: expected unsent notifications'; end if;
  select count(*) into n from public.claim_pushes(500) c where c.endpoint = 'https://fcm.googleapis.com/fcm/send/fake-two';
  if n < 1 then raise exception 'FAIL: the member with push on should have rows to send'; end if;
  select count(*) into n from public.notifications where push_sent_at is null;
  if n <> 0 then raise exception 'FAIL: claim should mark every notification sent (left %)', n; end if;
  select count(*) into n from public.claim_pushes(500);
  if n <> 0 then raise exception 'FAIL: a second claim must return nothing'; end if;

  raise notice 'notifications: ALL PASS';
end;
$$;

rollback;
