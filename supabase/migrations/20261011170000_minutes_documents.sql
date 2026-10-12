-- MVA-202: minutes (typed notes + file uploads) and members-only governance documents.
--
-- Nothing here is public. Document and minutes text lives in the database or the private
-- `minutes` storage bucket; it is never committed to the repo or shipped in the bundle.
-- Seeding: none. Lord delivers clean copies for Dax to upload through the UI after ratification.
--
-- Capabilities (decisions):
--   read_minutes     Member and above (was granted to every tier in the first seed; removed from
--                    Recruit, Prospect and Contractor here). Drafts are visible only to write_minutes.
--   write_minutes    Command (unchanged).
--   read_documents   NEW, Member and above. A separate key (not read_minutes) so documents can be
--                    opened up or locked down on their own in the tier screen.
--   publish_documents NEW, Command. Admin passes every capability check.

delete from public.tier_capabilities
where capability_key = 'read_minutes'
  and tier_id in (select id from public.tiers where name in ('Recruit', 'Prospect', 'Contractor'));

insert into public.capabilities (key, description) values
  ('read_documents', 'Read governance documents (bylaws, doctrine, charters, SOPs)'),
  ('publish_documents', 'Create, edit, ratify and supersede governance documents');

insert into public.tier_capabilities (tier_id, capability_key)
select t.id, 'read_documents' from public.tiers t where t.name in ('Command', 'Old Guard', 'Member');

insert into public.tier_capabilities (tier_id, capability_key)
select t.id, 'publish_documents' from public.tiers t where t.name = 'Command';

------------------------------------------------------------------------------
-- Minutes
------------------------------------------------------------------------------

create table public.minutes (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 160),
  meeting_date date not null,
  body_md text check (body_md is null or length(body_md) <= 200000),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'draft' check (status in ('draft', 'published'))
);

create index minutes_date_idx on public.minutes (meeting_date desc);

create table public.minutes_files (
  id uuid primary key default gen_random_uuid(),
  minutes_id uuid not null references public.minutes (id) on delete cascade,
  storage_path text not null unique,
  filename text not null check (length(filename) between 1 and 200),
  mime_type text not null check (mime_type in (
    'application/pdf', 'text/plain', 'text/markdown',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  uploaded_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Only these extensions, whatever the client says the MIME type is.
  constraint minutes_files_extension check (lower(filename) ~ '\.(pdf|txt|md|docx)$'),
  -- <minutes id>/<uuid>-<safe name>: no traversal, no surprises.
  constraint minutes_files_path check (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,120}$'
  )
);

create index minutes_files_minutes_idx on public.minutes_files (minutes_id);

create function public.minutes_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger minutes_prepare
  before insert or update on public.minutes
  for each row execute function public.minutes_prepare();

-- Audit (titles and states only, never body text).
create function public.minutes_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'minutes_created', new.title, new.status);
  elsif tg_op = 'DELETE' then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'minutes_deleted', old.title, null);
  elsif new.status is distinct from old.status then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), case when new.status = 'published' then 'minutes_published' else 'minutes_unpublished' end, new.title, null);
  elsif (new.title, new.meeting_date, new.body_md) is distinct from (old.title, old.meeting_date, old.body_md) then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'minutes_edited', new.title, null);
  end if;
  return null;
end;
$$;

create trigger minutes_audit
  after insert or update or delete on public.minutes
  for each row execute function public.minutes_audit();

create function public.minutes_files_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  r public.minutes_files := case when tg_op = 'DELETE' then old else new end;
  t text;
begin
  select m.title into t from public.minutes m where m.id = r.minutes_id;
  if t is null then
    return null;  -- the minutes themselves are being deleted
  end if;
  insert into public.settings_audit (actor_id, event, target, detail)
  values (auth.uid(), case when tg_op = 'DELETE' then 'minutes_file_removed' else 'minutes_file_added' end, t, r.filename);
  return null;
end;
$$;

create trigger minutes_files_audit
  after insert or delete on public.minutes_files
  for each row execute function public.minutes_files_audit();

------------------------------------------------------------------------------
-- Documents (governance)
------------------------------------------------------------------------------

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  title text not null check (length(btrim(title)) between 1 and 160),
  doc_type text not null check (doc_type in ('Bylaws', 'Doctrine', 'Role Charters', 'Onboarding SOP', 'Other')),
  version text not null check (length(btrim(version)) between 1 and 30),
  status text not null default 'draft' check (status in ('draft', 'ratified', 'superseded')),
  effective_date date,
  body_md text not null default '' check (length(body_md) <= 500000),
  published boolean not null default false,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slug, version),
  -- Drafts are never published to readers.
  constraint documents_draft_unpublished check (not (status = 'draft' and published))
);

-- One ratified version per slug, enforced by the database.
create unique index documents_one_ratified on public.documents (slug) where status = 'ratified';

create function public.documents_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  new.version := btrim(new.version);
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  -- Ratifying a version supersedes the one it replaces, so the unique index never trips.
  if new.status = 'ratified' then
    update public.documents d set status = 'superseded'
     where d.slug = new.slug and d.status = 'ratified' and d.id <> new.id;
  end if;
  return new;
end;
$$;

create trigger documents_prepare
  before insert or update on public.documents
  for each row execute function public.documents_prepare();

create function public.documents_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'document_created', new.title, 'v' || new.version);
  elsif tg_op = 'DELETE' then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'document_deleted', old.title, 'v' || old.version);
  elsif new.status is distinct from old.status then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'document_' || new.status, new.title, 'v' || new.version);
  elsif new.published is distinct from old.published then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), case when new.published then 'document_published' else 'document_unpublished' end, new.title, 'v' || new.version);
  elsif (new.title, new.doc_type, new.version, new.effective_date, new.body_md)
        is distinct from (old.title, old.doc_type, old.version, old.effective_date, old.body_md) then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'document_edited', new.title, 'v' || new.version);
  end if;
  return null;
end;
$$;

create trigger documents_audit
  after insert or update or delete on public.documents
  for each row execute function public.documents_audit();

revoke all on function public.minutes_prepare() from public, anon, authenticated;
revoke all on function public.minutes_audit() from public, anon, authenticated;
revoke all on function public.minutes_files_audit() from public, anon, authenticated;
revoke all on function public.documents_prepare() from public, anon, authenticated;
revoke all on function public.documents_audit() from public, anon, authenticated;

------------------------------------------------------------------------------
-- Grants and RLS
------------------------------------------------------------------------------

revoke all on public.minutes, public.minutes_files, public.documents from anon, authenticated;

grant select on public.minutes, public.minutes_files, public.documents to authenticated;
grant insert (title, meeting_date, body_md, status) on public.minutes to authenticated;
grant update (title, meeting_date, body_md, status) on public.minutes to authenticated;
grant delete on public.minutes to authenticated;
grant insert (minutes_id, storage_path, filename, mime_type, size_bytes) on public.minutes_files to authenticated;
grant delete on public.minutes_files to authenticated;
grant insert (slug, title, doc_type, version, status, effective_date, body_md, published) on public.documents to authenticated;
grant update (title, doc_type, version, status, effective_date, body_md, published) on public.documents to authenticated;
grant delete on public.documents to authenticated;

alter table public.minutes enable row level security;
alter table public.minutes_files enable row level security;
alter table public.documents enable row level security;

-- Minutes: published ones to read_minutes holders; drafts (and everything) to write_minutes holders.
create policy minutes_select on public.minutes
  for select to authenticated
  using ((status = 'published' and public.has_capability('read_minutes')) or public.has_capability('write_minutes'));
create policy minutes_insert on public.minutes
  for insert to authenticated with check (public.has_capability('write_minutes'));
create policy minutes_update on public.minutes
  for update to authenticated
  using (public.has_capability('write_minutes')) with check (public.has_capability('write_minutes'));
create policy minutes_delete on public.minutes
  for delete to authenticated using (public.has_capability('write_minutes'));

-- Files follow their minutes.
create policy minutes_files_select on public.minutes_files
  for select to authenticated
  using (exists (
    select 1 from public.minutes m
    where m.id = minutes_files.minutes_id
      and ((m.status = 'published' and public.has_capability('read_minutes')) or public.has_capability('write_minutes'))
  ));
create policy minutes_files_insert on public.minutes_files
  for insert to authenticated with check (public.has_capability('write_minutes'));
create policy minutes_files_delete on public.minutes_files
  for delete to authenticated using (public.has_capability('write_minutes'));

-- Documents: published, non-draft ones to read_documents holders; everything to publishers.
create policy documents_select on public.documents
  for select to authenticated
  using ((published and status <> 'draft' and public.has_capability('read_documents')) or public.has_capability('publish_documents'));
create policy documents_insert on public.documents
  for insert to authenticated with check (public.has_capability('publish_documents'));
create policy documents_update on public.documents
  for update to authenticated
  using (public.has_capability('publish_documents')) with check (public.has_capability('publish_documents'));
create policy documents_delete on public.documents
  for delete to authenticated using (public.has_capability('publish_documents'));

------------------------------------------------------------------------------
-- Private storage bucket for minutes files (only where the storage schema exists: Supabase
-- and the local CLI stack, not the bare-Postgres test harness).
------------------------------------------------------------------------------
-- No public URLs. Reads need a short-lived signed URL, which Supabase only issues to a caller
-- the select policy below allows: a published minutes file for read_minutes holders, or any
-- file for write_minutes holders. Uploads and deletes need write_minutes, a file-extension
-- whitelist and the <minutes id>/<uuid>-<name> path shape. The bucket caps files at 10 MB.
-- (Content sniffing by magic bytes is done in the app before upload; storage cannot do it.)

do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('minutes', 'minutes', false, 10485760, array[
    'application/pdf', 'text/plain', 'text/markdown',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ])
  on conflict (id) do update set public = false, file_size_limit = 10485760,
    allowed_mime_types = excluded.allowed_mime_types;

  execute $p$
    create policy minutes_objects_select on storage.objects
      for select to authenticated
      using (
        bucket_id = 'minutes' and (
          -- Writers can see every object in the bucket. This also lets an upload return its new row
          -- before its minutes_files row exists (upload first, record second).
          public.has_capability('write_minutes')
          or exists (
            select 1 from public.minutes_files f join public.minutes m on m.id = f.minutes_id
            where f.storage_path = storage.objects.name
              and m.status = 'published' and public.has_capability('read_minutes')
          )
        )
      )
  $p$;
  execute $p$
    create policy minutes_objects_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'minutes' and public.has_capability('write_minutes')
        and lower(name) ~ '\.(pdf|txt|md|docx)$'
        and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,120}$'
      )
  $p$;
  execute $p$
    create policy minutes_objects_delete on storage.objects
      for delete to authenticated
      using (bucket_id = 'minutes' and public.has_capability('write_minutes'))
  $p$;
end;
$$;
