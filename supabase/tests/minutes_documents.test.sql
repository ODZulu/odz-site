-- Tier 1 database tests for MVA-202: minutes, minutes files, governance documents.
-- Plain SQL, one rolled-back transaction, fake data only. (The storage bucket policies need the
-- storage schema and are exercised by the Tier 2 suite on the local Supabase stack.)

begin;

do $$
declare
  v_cmd uuid := '00000000-0000-0000-0000-0000000000c1';
  v_mem uuid := '00000000-0000-0000-0000-0000000000b1';
  v_rec uuid := '00000000-0000-0000-0000-0000000000f1';
  t_cmd uuid; t_og uuid; t_mem uuid; t_recruit uuid;
  m1 uuid; m2 uuid; d1 uuid; d2 uuid; d3 uuid;
  n integer;
begin
  select id into t_cmd from public.tiers where name = 'Command';
  select id into t_og from public.tiers where name = 'Old Guard';
  select id into t_mem from public.tiers where name = 'Member';
  select id into t_recruit from public.tiers where name = 'Recruit';

  insert into public.invites (code, tier_id)
  select 'mdfake00000000' || g, t_recruit from generate_series(10, 12) g;
  insert into auth.users (id, email, aud, role, raw_user_meta_data) values
    (v_cmd, 'cmd@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"mdfake0000000010"}'),
    (v_mem, 'mem@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"mdfake0000000011"}'),
    (v_rec, 'rec@example.invalid', 'authenticated', 'authenticated', '{"invite_code":"mdfake0000000012"}');
  update public.profiles set status = 'approved', tier_id = t_og, setup_complete = true, callsign = 'Fake-Cmd' where id = v_cmd;
  update public.profiles set tier_id = t_cmd where id = v_cmd;
  update public.profiles set status = 'approved', tier_id = t_mem, setup_complete = true, callsign = 'Fake-Mem' where id = v_mem;
  update public.profiles set status = 'approved', setup_complete = true, callsign = 'Fake-Rec' where id = v_rec;

  ------------------------------------------------------------------ seed
  select count(*) into n from public.tier_capabilities tc join public.tiers t on t.id = tc.tier_id
    where tc.capability_key = 'read_minutes' and t.name in ('Recruit', 'Prospect', 'Contractor');
  if n <> 0 then raise exception 'FAIL: junior tiers should not read minutes'; end if;
  select count(*) into n from public.tier_capabilities where capability_key = 'publish_documents';
  if n <> 1 then raise exception 'FAIL: only Command should publish documents'; end if;
  select count(*) into n from public.tier_capabilities tc join public.tiers t on t.id = tc.tier_id
    where tc.capability_key = 'read_documents' and t.name in ('Command', 'Old Guard', 'Member');
  if n <> 3 then raise exception 'FAIL: Member and above should read documents'; end if;
  select count(*) into n from public.minutes;     if n <> 0 then raise exception 'FAIL: minutes must start empty'; end if;
  select count(*) into n from public.documents;   if n <> 0 then raise exception 'FAIL: documents must start empty'; end if;

  ------------------------------------------------------------------ Command writes minutes
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.minutes (title, meeting_date, body_md) values ('Fake Meeting Draft', date '2026-10-01', '# Fake notes') returning id into m1;
  insert into public.minutes (title, meeting_date, body_md, status) values ('Fake Meeting Published', date '2026-10-02', 'text', 'published') returning id into m2;

  begin insert into public.minutes (title, meeting_date, status) values ('  ', date '2026-10-01', 'draft'); raise exception 'FAIL: blank title';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.minutes (title, meeting_date, status) values ('x', date '2026-10-01', 'archived'); raise exception 'FAIL: bad status';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  -- File rows: safe paths and types only.
  insert into public.minutes_files (minutes_id, storage_path, filename, mime_type, size_bytes)
  values (m2, m2 || '/' || gen_random_uuid() || '-notes.pdf', 'notes.pdf', 'application/pdf', 1234);
  begin insert into public.minutes_files (minutes_id, storage_path, filename, mime_type, size_bytes)
    values (m2, '../escape/notes.pdf', 'notes.pdf', 'application/pdf', 10); raise exception 'FAIL: traversal path accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.minutes_files (minutes_id, storage_path, filename, mime_type, size_bytes)
    values (m2, m2 || '/' || gen_random_uuid() || '-run.exe', 'run.exe', 'application/pdf', 10); raise exception 'FAIL: .exe accepted despite pdf mime';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.minutes_files (minutes_id, storage_path, filename, mime_type, size_bytes)
    values (m2, m2 || '/' || gen_random_uuid() || '-big.pdf', 'big.pdf', 'application/pdf', 10485761); raise exception 'FAIL: 10 MB + 1 accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.minutes_files (minutes_id, storage_path, filename, mime_type, size_bytes)
    values (m2, m2 || '/' || gen_random_uuid() || '-x.pdf', 'x.pdf', 'text/html', 10); raise exception 'FAIL: html mime accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  update public.minutes set status = 'published' where id = m1;
  update public.minutes set status = 'draft' where id = m1;
  update public.minutes set body_md = '# Fake notes v2' where id = m1;

  select count(*) into n from public.settings_audit where target = 'Fake Meeting Draft'
    and event in ('minutes_created', 'minutes_published', 'minutes_unpublished', 'minutes_edited');
  if n <> 4 then raise exception 'FAIL: minutes audit rows (got %)', n; end if;
  select count(*) into n from public.settings_audit where detail ~* 'Fake notes';
  if n <> 0 then raise exception 'FAIL: audit leaked minutes text'; end if;
  select count(*) into n from public.settings_audit where event = 'minutes_file_added' and detail = 'notes.pdf';
  if n <> 1 then raise exception 'FAIL: file upload not audited'; end if;

  ------------------------------------------------------------------ documents: publishing and the one-ratified rule
  insert into public.documents (slug, title, doc_type, version, body_md) values ('fake-bylaws', 'Fake Bylaws', 'Bylaws', '1.0', '# Fake') returning id into d1;
  begin update public.documents set published = true where id = d1; raise exception 'FAIL: published a draft';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  update public.documents set status = 'ratified', published = true, effective_date = date '2026-10-05' where id = d1;

  insert into public.documents (slug, title, doc_type, version, body_md) values ('fake-bylaws', 'Fake Bylaws', 'Bylaws', '1.1', '# Fake 1.1') returning id into d2;
  begin insert into public.documents (slug, title, doc_type, version) values ('fake-bylaws', 'Fake Bylaws', 'Bylaws', '1.1'); raise exception 'FAIL: duplicate slug+version';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.documents (slug, title, doc_type, version) values ('Bad Slug', 'x', 'Bylaws', '1'); raise exception 'FAIL: bad slug';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin insert into public.documents (slug, title, doc_type, version) values ('fake-x', 'x', 'Memoir', '1'); raise exception 'FAIL: bad type';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  update public.documents set status = 'ratified', published = true where id = d2;
  select count(*) into n from public.documents where slug = 'fake-bylaws' and status = 'ratified';
  if n <> 1 then raise exception 'FAIL: exactly one ratified version expected (got %)', n; end if;
  select count(*) into n from public.documents where id = d1 and status = 'superseded';
  if n <> 1 then raise exception 'FAIL: ratifying 1.1 should supersede 1.0'; end if;
  select count(*) into n from public.settings_audit where event = 'document_superseded' and target = 'Fake Bylaws';
  if n <> 1 then raise exception 'FAIL: supersede not audited'; end if;

  insert into public.documents (slug, title, doc_type, version, body_md) values ('fake-sop', 'Fake SOP', 'Onboarding SOP', '0.1', 'draft text') returning id into d3;

  ------------------------------------------------------------------ Member: reads published only
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.minutes; if n <> 1 then raise exception 'FAIL: member should see only the published minutes (got %)', n; end if;
  select count(*) into n from public.minutes where id = m1; if n <> 0 then raise exception 'FAIL: member saw a draft'; end if;
  select count(*) into n from public.minutes_files; if n <> 1 then raise exception 'FAIL: member should see the published minutes file'; end if;
  select count(*) into n from public.documents; if n <> 2 then raise exception 'FAIL: member should see ratified + superseded, not drafts (got %)', n; end if;
  select count(*) into n from public.documents where id = d3; if n <> 0 then raise exception 'FAIL: member saw a draft document'; end if;
  begin insert into public.minutes (title, meeting_date) values ('Fake member', date '2026-10-01'); raise exception 'FAIL: member wrote minutes';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  update public.minutes set title = 'Hacked' where id = m2;
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: member edited minutes'; end if;
  delete from public.documents where id = d2;
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: member deleted a document'; end if;
  begin insert into public.documents (slug, title, doc_type, version) values ('fake-m', 'x', 'Other', '1'); raise exception 'FAIL: member wrote a document';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  ------------------------------------------------------------------ Recruit and anon: nothing
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rec, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.minutes; if n <> 0 then raise exception 'FAIL: recruit read minutes'; end if;
  select count(*) into n from public.minutes_files; if n <> 0 then raise exception 'FAIL: recruit read minutes files'; end if;
  select count(*) into n from public.documents; if n <> 0 then raise exception 'FAIL: recruit read documents'; end if;

  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform 1 from public.minutes; raise exception 'FAIL: anon read minutes';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform 1 from public.documents; raise exception 'FAIL: anon read documents';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform 1 from public.minutes_files; raise exception 'FAIL: anon read minutes files';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  ------------------------------------------------------------------ Command deletes
  perform set_config('request.jwt.claims', json_build_object('sub', v_cmd, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.minutes; if n <> 2 then raise exception 'FAIL: command should see both minutes'; end if;
  select count(*) into n from public.documents; if n <> 3 then raise exception 'FAIL: command should see all documents'; end if;
  delete from public.minutes where id = m2;
  select count(*) into n from public.minutes_files; if n <> 0 then raise exception 'FAIL: files should go with their minutes'; end if;
  delete from public.documents where id = d3;
  reset role;

  raise notice 'minutes_documents: ALL PASS';
end;
$$;

rollback;
