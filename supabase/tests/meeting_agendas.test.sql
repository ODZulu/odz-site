-- Tier 1 database tests for MVA-245: meeting agendas.
-- Plain SQL, one rolled-back transaction, fake data only.

begin;

do $$
declare
  v_adm uuid := '00000000-0000-0000-0000-0000000000a1';
  v_cmd uuid := '00000000-0000-0000-0000-0000000000c1';
  v_mem uuid := '00000000-0000-0000-0000-0000000000d1';
  v_pre uuid := '00000000-0000-0000-0000-0000000000d2';
  v_rec uuid := '00000000-0000-0000-0000-0000000000d3';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  ev uuid; ev_other uuid; ev_cancel uuid;
  ag uuid; ag_other uuid; ag_cancel uuid; ag_empty uuid; ev_empty uuid;
  i1 uuid; i2 uuid; i3 uuid; i4 uuid;
  doc1 uuid; doc2 uuid;
  mn uuid;
  n integer;
  body text;
  r record;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  ------------------------------------------------------------------ seed
  insert into public.invites (code, tier_id)
  select 'agfake000000000' || to_char(g, 'FM00'), t_recruit from generate_series(10, 14) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_adm, 'adm@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"agfake00000000010"}'),
    (v_cmd, 'cmd@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"agfake00000000011"}'),
    (v_mem, 'mem@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"agfake00000000012"}'),
    (v_pre, 'pre@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"agfake00000000013"}'),
    (v_rec, 'rec@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"agfake00000000014"}');
  update public.profiles set status = 'approved', tier_id = t_mem, is_admin = true, setup_complete = true, callsign = 'Fake-Adm' where id = v_adm;
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Pre' where id = v_pre;
  update public.profiles set status = 'approved', tier_id = t_recruit, setup_complete = true, callsign = 'Fake-Rec' where id = v_rec;

  insert into public.events (title, event_type, starts_at, ends_at)
  values ('Fake change meeting', 'Meeting', now() + interval '2 days', now() + interval '2 days 1 hour') returning id into ev;
  insert into public.events (title, event_type, starts_at) values ('Fake game day', 'Game Day', now() + interval '3 days') returning id into ev_other;
  insert into public.events (title, event_type, starts_at, status) values ('Fake cancelled meeting', 'Meeting', now() + interval '4 days', 'cancelled') returning id into ev_cancel;
  insert into public.events (title, event_type, starts_at) values ('Fake empty meeting', 'Meeting', now() + interval '5 days') returning id into ev_empty;

  ------------------------------------------------------------------ building: Command only, Meetings only
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin insert into public.agendas (event_id) values (ev); raise exception 'FAIL: Member created an agenda';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform count(*) from public.agendas; raise exception 'FAIL: anon read agendas';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.publish_agenda('00000000-0000-0000-0000-000000000001'); raise exception 'FAIL: anon published';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin insert into public.agendas (event_id) values (ev_other); raise exception 'FAIL: agenda on a non-meeting';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not_a_meeting' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin insert into public.agendas (event_id, status, publish_count) values (ev, 'published', 3); raise exception 'FAIL: client set the status';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  insert into public.agendas (event_id) values (ev) returning id into ag;
  insert into public.agendas (event_id) values (ev_cancel) returning id into ag_cancel;
  insert into public.agendas (event_id) values (ev_empty) returning id into ag_empty;
  begin insert into public.agendas (event_id) values (ev); raise exception 'FAIL: two agendas for one event';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  select count(*) into n from public.agendas where id = ag and status = 'draft' and publish_count = 0;
  if n <> 1 then raise exception 'FAIL: a new agenda is a draft'; end if;

  insert into public.agenda_items (agenda_id, position, title, planned_minutes, kind, notes_md)
    values (ag, 1, 'Fake welcome and roll', 10, 'inform', 'Fake public note') returning id into i1;
  insert into public.agenda_items (agenda_id, position, title, planned_minutes, kind, visibility, notes_md)
    values (ag, 2, 'Fake Command-only business', 15, 'discuss', 'command', 'Fake command note') returning id into i2;
  insert into public.agenda_items (agenda_id, position, title, planned_minutes, kind, visibility, presenter_id)
    values (ag, 3, 'Fake presenter-only slot', 20, 'inform', 'presenter', v_pre) returning id into i3;
  insert into public.agenda_items (agenda_id, position, title, planned_minutes, kind, vote_wording)
    values (ag, 4, 'Fake vote on the fake bylaw', 30, 'vote', 'Shall the fake bylaw be adopted as written?') returning id into i4;
  begin insert into public.agenda_items (agenda_id, title, visibility) values (ag, 'Fake no presenter', 'presenter'); raise exception 'FAIL: presenter level without a presenter';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.agenda_items (agenda_id, title, notes_md) values (ag, 'Fake long', repeat('x', 3001)); raise exception 'FAIL: notes over 3000 accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.agenda_items (agenda_id, title, planned_minutes, kind) values (ag, 'Fake bad kind', 5, 'party'); raise exception 'FAIL: bad kind accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  insert into public.agenda_item_notes (item_id, presenter_notes_md) values (i1, 'Fake presenter secret on item 1');
  insert into public.agenda_item_notes (item_id, presenter_notes_md) values (i3, 'Fake presenter secret on item 3');
  insert into public.agenda_items (agenda_id, position, title) values (ag_empty, 1, 'Fake one item') returning id into i3 ;
  delete from public.agenda_items where id = i3;
  select id into i3 from public.agenda_items where agenda_id = ag and position = 3;
  reset role;

  ------------------------------------------------------------------ drafts are Command and Admin only
  foreach body in array array['mem', 'pre', 'rec'] loop
    perform set_config('request.jwt.claims', json_build_object('sub',
      case body when 'mem' then v_mem when 'pre' then v_pre else v_rec end, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.agendas;
    if n <> 0 then raise exception 'FAIL: % sees a draft agenda', body; end if;
    select count(*) into n from public.agenda_items;
    if n <> 0 then raise exception 'FAIL: % sees draft items', body; end if;
    select count(*) into n from public.agenda_item_notes;
    if n <> 0 then raise exception 'FAIL: % sees draft presenter notes', body; end if;
    reset role;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.agenda_items where agenda_id = ag;
  if n <> 4 then raise exception 'FAIL: Admin sees the whole draft (got %)', n; end if;
  reset role;

  ------------------------------------------------------------------ publish
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.publish_agenda(ag); raise exception 'FAIL: Member published';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.publish_agenda(ag_empty); n := 0; exception when others then n := 1; if sqlerrm <> 'empty_agenda' and sqlerrm <> 'not_found' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.publish_agenda(ag_cancel); raise exception 'FAIL: published for a cancelled event';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'event_cancelled' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  if public.publish_agenda(ag) <> 1 then raise exception 'FAIL: first publish should return 1'; end if;
  begin perform public.publish_agenda(ag); raise exception 'FAIL: republish with nothing changed';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'nothing_to_publish' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  reset role;
  select count(*) into n from public.agendas where id = ag and status = 'published' and publish_count = 1 and published_at is not null;
  if n <> 1 then raise exception 'FAIL: agenda not published'; end if;
  select count(*) into n from public.agenda_publish_log where agenda_id = ag and action = 'published' and actor_id = v_cmd and actor_callsign = 'Fake-Cmd';
  if n <> 1 then raise exception 'FAIL: publish not logged with who'; end if;
  select count(*) into n from public.notifications where kind = 'agenda' and title like 'Agenda published: Fake change meeting' and link = '/agenda/' || ev::text;
  if n < 3 then raise exception 'FAIL: audience not notified (got %)', n; end if;
  select count(*) into n from public.notifications where kind = 'agenda' and profile_id = v_rec;
  if n <> 0 then raise exception 'FAIL: a Recruit (no event details) was notified'; end if;

  -- The publish log is permanent.
  begin update public.agenda_publish_log set action = 'republished' where agenda_id = ag; raise exception 'FAIL: publish log edited';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin delete from public.agenda_publish_log where agenda_id = ag; raise exception 'FAIL: publish log deleted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ levels after publishing
  -- A Member: the Members-level items only, no presenter notes at all.
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.agendas where id = ag;
  if n <> 1 then raise exception 'FAIL: Member should see the published agenda'; end if;
  select count(*) into n from public.agenda_items where agenda_id = ag;
  if n <> 2 then raise exception 'FAIL: Member should see exactly the 2 Members-level items (got %)', n; end if;
  select count(*) into n from public.agenda_items where id in (i2, i3);
  if n <> 0 then raise exception 'FAIL: Member sees a Command or Presenter item'; end if;
  select count(*) into n from public.agenda_item_notes;
  if n <> 0 then raise exception 'FAIL: Member reads presenter notes'; end if;
  select count(*) into n from public.agenda_publish_log where agenda_id = ag;
  if n <> 1 then raise exception 'FAIL: Member should see who published'; end if;
  begin insert into public.agenda_items (agenda_id, title) values (ag, 'Fake member item'); raise exception 'FAIL: Member added an item';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  update public.agenda_items set title = 'Fake hijack' where id = i1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: Member edited an item'; end if;
  begin perform public.create_minutes_from_agenda(ag); raise exception 'FAIL: Member created minutes from an agenda';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'not allowed' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  begin perform public.reorder_agenda_items(ag, array[i1, i2, i3, i4]); raise exception 'FAIL: Member reordered';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- The named presenter: Members-level items, plus their own Presenter-level item and its notes (not the notes of others).
  perform set_config('request.jwt.claims', json_build_object('sub', v_pre, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.agenda_items where agenda_id = ag;
  if n <> 3 then raise exception 'FAIL: presenter should see 2 member items + their own (got %)', n; end if;
  select count(*) into n from public.agenda_items where id = i2;
  if n <> 0 then raise exception 'FAIL: presenter sees a Command item'; end if;
  select count(*) into n from public.agenda_item_notes where item_id = i3;
  if n <> 1 then raise exception 'FAIL: presenter should read their own item''s notes'; end if;
  select count(*) into n from public.agenda_item_notes where item_id = i1;
  if n <> 0 then raise exception 'FAIL: presenter reads notes on someone else''s item'; end if;
  reset role;

  -- A Recruit cannot read event details, so sees no agenda; anon never.
  perform set_config('request.jwt.claims', json_build_object('sub', v_rec, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.agendas;
  if n <> 0 then raise exception 'FAIL: Recruit sees an agenda'; end if;
  select count(*) into n from public.agenda_items;
  if n <> 0 then raise exception 'FAIL: Recruit sees items'; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform count(*) from public.agenda_items; raise exception 'FAIL: anon read agenda items';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform count(*) from public.agenda_item_notes; raise exception 'FAIL: anon read presenter notes';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- Command and Admin see everything.
  foreach body in array array['cmd', 'adm'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', case body when 'cmd' then v_cmd else v_adm end, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.agenda_items where agenda_id = ag;
    if n <> 4 then raise exception 'FAIL: % sees all 4 items (got %)', body, n; end if;
    select count(*) into n from public.agenda_item_notes;
    if n <> 2 then raise exception 'FAIL: % reads all presenter notes (got %)', body, n; end if;
    reset role;
  end loop;

  ------------------------------------------------------------------ pre-read documents respect the item's level and the document's own rules
  insert into public.documents (slug, title, doc_type, version, status, body_md, published)
    values ('fake-bylaw', 'Fake bylaw', 'Bylaws', '1', 'ratified', 'Fake text', true) returning id into doc1;
  insert into public.documents (slug, title, doc_type, version, status, body_md, published)
    values ('fake-draft', 'Fake draft doc', 'Other', '1', 'draft', 'Fake draft text', false) returning id into doc2;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.agenda_item_documents (item_id, document_id) values (i4, doc1);
  insert into public.agenda_item_documents (item_id, document_id) values (i4, doc2);
  insert into public.agenda_item_documents (item_id, document_id) values (i2, doc1);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.agenda_item_documents;
  if n <> 2 then raise exception 'FAIL: Member sees the links on Members-level items only (got %)', n; end if;
  select count(*) into n from public.documents where id = doc2;
  if n <> 0 then raise exception 'FAIL: a link must not expose a draft document'; end if;
  select count(*) into n from public.documents where id = doc1;
  if n <> 1 then raise exception 'FAIL: a published document stays readable'; end if;
  begin insert into public.agenda_item_documents (item_id, document_id) values (i1, doc1); raise exception 'FAIL: Member linked a document';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ edits after publishing, republish
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.agenda_items set outcome_md = 'Fake outcome' where id = i4;          -- not an agenda change
  update public.agenda_items set position = 4 where id = i1;                          -- not an agenda change
  update public.agenda_items set position = 1 where id = i1;
  reset role;
  select count(*) into n from public.agenda_items where agenda_id = ag and edited_since_publish;
  if n <> 0 then raise exception 'FAIL: outcome and order changes must not mark an item updated'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.agenda_items set title = 'Fake welcome and roll call' where id = i1;
  insert into public.agenda_items (agenda_id, position, title) values (ag, 5, 'Fake late addition');
  reset role;
  select count(*) into n from public.agenda_items where agenda_id = ag and edited_since_publish;
  if n <> 2 then raise exception 'FAIL: the edited and the added item are marked (got %)', n; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.publish_agenda(ag); raise exception 'FAIL: Member republished';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.publish_agenda(ag) <> 2 then raise exception 'FAIL: republish should return 2'; end if;
  reset role;
  select count(*) into n from public.agenda_items where agenda_id = ag and updated_in_publish = 2 and not edited_since_publish;
  if n <> 2 then raise exception 'FAIL: the 2 changed items carry the updated mark (got %)', n; end if;
  select count(*) into n from public.agenda_items where agenda_id = ag and updated_in_publish is null;
  if n <> 3 then raise exception 'FAIL: unchanged items carry no mark (got %)', n; end if;
  select count(*) into n from public.agenda_publish_log where agenda_id = ag and action = 'republished';
  if n <> 1 then raise exception 'FAIL: republish not logged'; end if;
  select count(*) into n from public.notifications where kind = 'agenda' and title = 'Agenda updated: Fake change meeting';
  if n < 3 then raise exception 'FAIL: republish should notify again (got %)', n; end if;

  ------------------------------------------------------------------ reorder
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.reorder_agenda_items(ag, array[i1, i2]); raise exception 'FAIL: partial order accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; if sqlerrm <> 'bad_order' then raise exception 'FAIL: wrong error %', sqlerrm; end if; end;
  select id into i3 from public.agenda_items where agenda_id = ag and title = 'Fake late addition';
  perform public.reorder_agenda_items(ag, array[i3, i4, (select id from public.agenda_items where agenda_id = ag and position = 3 limit 1), i2, i1]);
  reset role;
  select count(*) into n from public.agenda_items where id = i3 and position = 1;
  if n <> 1 then raise exception 'FAIL: reorder did not apply'; end if;

  ------------------------------------------------------------------ minutes from the agenda
  insert into public.event_rsvps (event_id, profile_id, response) values (ev, v_mem, 'in');
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  mn := public.create_minutes_from_agenda(ag);
  reset role;
  select * into r from public.minutes where id = mn;
  if r.status <> 'draft' or r.title <> 'Minutes: Fake change meeting' then raise exception 'FAIL: minutes should be a draft titled from the event'; end if;
  if r.body_md not like '%Fake welcome and roll call%' or r.body_md not like '%Shall the fake bylaw be adopted as written?%'
     or r.body_md not like '%Fake outcome%' or r.body_md not like '%Attendees%' or r.body_md not like '%Fake-Mem%' then
    raise exception 'FAIL: minutes missing headings, wording, outcome or attendees: %', r.body_md;
  end if;
  if r.body_md like '%Fake Command-only business%' or r.body_md like '%Fake presenter-only slot%'
     or r.body_md like '%Fake presenter secret%' or r.body_md like '%Fake command note%' then
    raise exception 'FAIL: minutes copied Command-level items or presenter notes by default';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  mn := public.create_minutes_from_agenda(ag, true, true);
  reset role;
  select body_md into body from public.minutes where id = mn;
  if body not like '%Fake Command-only business%' or body not like '%Fake presenter secret on item 1%' then
    raise exception 'FAIL: explicit include should copy Command items and presenter notes';
  end if;

  raise notice 'meeting agendas: ALL PASS';
end;
$$;

rollback;
