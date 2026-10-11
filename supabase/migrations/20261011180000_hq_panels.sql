-- MVA-142: HQ panels. Traffic (announcements), event RSVPs with a readiness count, and a tier
-- breakdown. Everything is for approved members only; the counts never carry names.
--
-- Decisions (Lord defaults):
--   * write_traffic (new) posts traffic; default Command, Admin passes every check.
--   * RSVP is IN / OUT / TBD per member per event; a member changes only their own, only until the
--     event starts, and never for a cancelled event.
--   * Readiness counts IN against the eligible members: approved members whose tier has
--     counts_for_readiness (Command, Old Guard, Member, Contractor). That is data on the tier, so it
--     follows tier renames and reordering.
--   * The tier breakdown is a function that returns (tier, count) only.

insert into public.capabilities (key, description) values
  ('write_traffic', 'Post and archive traffic (announcements)');

insert into public.tier_capabilities (tier_id, capability_key)
select t.id, 'write_traffic' from public.tiers t where t.name = 'Command';

alter table public.tiers add column counts_for_readiness boolean not null default false;
update public.tiers set counts_for_readiness = true where name in ('Command', 'Old Guard', 'Member', 'Contractor');

------------------------------------------------------------------------------
-- Traffic
------------------------------------------------------------------------------

create table public.traffic (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 80),
  body text not null check (length(btrim(body)) between 1 and 1000),
  pinned boolean not null default false,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index traffic_feed_idx on public.traffic (pinned desc, created_at desc) where archived_at is null;

create function public.traffic_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  new.body := btrim(new.body);
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger traffic_prepare
  before insert or update on public.traffic
  for each row execute function public.traffic_prepare();

-- Titles only in the audit log, never bodies.
create function public.traffic_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'traffic_posted', new.title, case when new.pinned then 'pinned' end);
  elsif new.archived_at is distinct from old.archived_at then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), case when new.archived_at is null then 'traffic_restored' else 'traffic_archived' end, new.title, null);
  elsif (new.title, new.body, new.pinned) is distinct from (old.title, old.body, old.pinned) then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (auth.uid(), 'traffic_edited', new.title, case when new.pinned is distinct from old.pinned then case when new.pinned then 'pinned' else 'unpinned' end end);
  end if;
  return null;
end;
$$;

create trigger traffic_audit
  after insert or update on public.traffic
  for each row execute function public.traffic_audit();

revoke all on function public.traffic_prepare() from public, anon, authenticated;
revoke all on function public.traffic_audit() from public, anon, authenticated;

revoke all on public.traffic from anon, authenticated;
grant select on public.traffic to authenticated;
grant insert (title, body, pinned) on public.traffic to authenticated;
grant update (title, body, pinned, archived_at) on public.traffic to authenticated;
-- No delete grant: archive only.

alter table public.traffic enable row level security;

-- Approved members read live traffic; writers also see the archive.
create policy traffic_select on public.traffic
  for select to authenticated
  using ((archived_at is null and public.current_user_is_approved()) or public.has_capability('write_traffic'));
create policy traffic_insert on public.traffic
  for insert to authenticated with check (public.has_capability('write_traffic'));
create policy traffic_update on public.traffic
  for update to authenticated
  using (public.has_capability('write_traffic')) with check (public.has_capability('write_traffic'));

------------------------------------------------------------------------------
-- RSVPs
------------------------------------------------------------------------------

create table public.event_rsvps (
  event_id uuid not null references public.events (id) on delete cascade,
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  response text not null check (response in ('in', 'out', 'tbd')),
  updated_at timestamptz not null default now(),
  primary key (event_id, profile_id)
);

create function public.event_rsvps_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.event_id := old.event_id;
    new.profile_id := old.profile_id;
  end if;
  return new;
end;
$$;

create trigger event_rsvps_prepare
  before insert or update on public.event_rsvps
  for each row execute function public.event_rsvps_prepare();

revoke all on function public.event_rsvps_prepare() from public, anon, authenticated;

revoke all on public.event_rsvps from anon, authenticated;
grant select on public.event_rsvps to authenticated;
grant insert (event_id, response) on public.event_rsvps to authenticated;
grant update (response) on public.event_rsvps to authenticated;

alter table public.event_rsvps enable row level security;

create policy event_rsvps_select on public.event_rsvps
  for select to authenticated using (public.has_capability('read_event_details'));

-- Own row only, and only for an upcoming, scheduled event. The same test guards updates, so
-- an RSVP can't be changed after the event starts or after it is cancelled.
create policy event_rsvps_insert on public.event_rsvps
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and public.has_capability('read_event_details')
    and exists (select 1 from public.events e where e.id = event_id and e.starts_at > now() and e.status = 'scheduled')
  );
create policy event_rsvps_update on public.event_rsvps
  for update to authenticated
  using (
    profile_id = (select auth.uid())
    and exists (select 1 from public.events e where e.id = event_id and e.starts_at > now() and e.status = 'scheduled')
  )
  with check (profile_id = (select auth.uid()));

------------------------------------------------------------------------------
-- Counts only
------------------------------------------------------------------------------

-- Readiness for one event: how many eligible members answered what. No names.
create function public.event_readiness(p_event uuid)
returns table (eligible integer, in_count integer, out_count integer, tbd_count integer, no_response integer)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.has_capability('read_event_details') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    with elig as (
      select p.id
      from public.profiles p
      join public.tiers t on t.id = p.tier_id
      where p.status = 'approved' and t.counts_for_readiness
    ),
    answers as (
      select r.response
      from public.event_rsvps r
      join elig on elig.id = r.profile_id
      where r.event_id = p_event
    )
    select
      (select count(*)::integer from elig),
      (select count(*)::integer from answers where response = 'in'),
      (select count(*)::integer from answers where response = 'out'),
      (select count(*)::integer from answers where response = 'tbd'),
      (select count(*)::integer from elig) - (select count(*)::integer from answers);
end;
$$;

-- Approved members per tier in rank order, zero-member tiers included. No names.
create function public.tier_breakdown()
returns table (tier_name text, tier_rank integer, member_count integer)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.current_user_is_approved() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select t.name, t.rank, count(p.id)::integer
    from public.tiers t
    left join public.profiles p on p.tier_id = t.id and p.status = 'approved'
    group by t.id, t.name, t.rank
    order by t.rank;
end;
$$;

revoke all on function public.event_readiness(uuid) from public, anon;
revoke all on function public.tier_breakdown() from public, anon;
grant execute on function public.event_readiness(uuid) to authenticated;
grant execute on function public.tier_breakdown() to authenticated;
