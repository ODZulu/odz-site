-- MVA-203 Phase A: in-app notifications and Android web push reminders. No email (Phase B waits
-- for SMTP, MVA-200).
--
-- Split of work (a deliberate refinement of the spec so the risky logic is testable in SQL):
--   * Selection and idempotency live here: generate_reminders() decides who is due a reminder,
--     writes the in-app notification and logs it so it never repeats. Database triggers raise
--     new / cancelled / changed notifications when events change. All of it is plain SQL with
--     tests; pg_cron runs generate_reminders() every 5 minutes.
--   * Delivery lives in the Edge Function `send-push` (supabase/functions/send-push): it claims
--     pending notifications with claim_pushes() (service role only), sends Web Push and prunes
--     dead subscriptions. VAPID keys are Edge Function secrets, never in the repo or a VITE_ var.
--
-- Payloads carry the event title and time only. Location and description are never copied here.

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

create table public.notification_prefs (
  profile_id uuid primary key default auth.uid() references public.profiles (id) on delete cascade,
  push_enabled boolean not null default false,
  lead_minutes integer[] not null default '{1440,120}',
  updated_at timestamptz not null default now(),
  -- Presets only: 24h, 12h, 2h, 30m.
  constraint notification_prefs_leads check (lead_minutes <@ array[1440, 720, 120, 30] and cardinality(lead_minutes) between 1 and 4)
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  -- Only the real browser push services: the sender will POST to whatever is stored here.
  endpoint text not null unique check (
    length(endpoint) <= 2000 and endpoint ~* '^https://(fcm.googleapis.com|[a-z0-9.-]+.push.services.mozilla.com|[a-z0-9.-]+.push.apple.com|[a-z0-9.-]+.notify.windows.com)/'
  ),
  p256dh text not null check (length(p256dh) between 20 and 200),
  auth text not null check (length(auth) between 8 and 100),
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);

create index push_subscriptions_profile_idx on public.push_subscriptions (profile_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('reminder', 'new', 'cancelled', 'changed', 'test')),
  title text not null check (length(title) between 1 and 200),
  body text not null check (length(body) <= 300),
  link text check (link is null or link ~ '^/[A-Za-z0-9/_-]*$'),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  push_sent_at timestamptz
);

create index notifications_profile_idx on public.notifications (profile_id, created_at desc);
create index notifications_unpushed_idx on public.notifications (created_at) where push_sent_at is null;

-- A reminder is generated at most once per (event, member, lead, channel).
create table public.reminder_log (
  event_id uuid not null references public.events (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  lead_minutes integer not null,
  channel text not null check (channel in ('in_app')),
  sent_at timestamptz not null default now(),
  primary key (event_id, profile_id, lead_minutes, channel)
);

create function public.notification_prefs_prepare()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.profile_id := old.profile_id; end if;
  return new;
end;
$$;

create trigger notification_prefs_prepare
  before insert or update on public.notification_prefs
  for each row execute function public.notification_prefs_prepare();

revoke all on function public.notification_prefs_prepare() from public, anon, authenticated;

------------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------------

-- Phoenix has no daylight saving, so a fixed offset is exact: UTC-7.
create function public.phoenix_stamp(ts timestamptz)
returns text
language sql immutable set search_path = ''
as $$
  select to_char((ts at time zone 'UTC') - interval '7 hours', 'DD MON YYYY HH24MI') || 'L'
$$;

-- Approved members who may read event details (admins pass every capability).
create function public.event_recipients()
returns table (profile_id uuid)
language sql stable security definer set search_path = ''
as $$
  select p.id
  from public.profiles p
  where p.status = 'approved'
    and (
      p.is_admin
      or exists (
        select 1 from public.tier_capabilities tc
        where tc.tier_id = p.tier_id and tc.capability_key = 'read_event_details'
      )
    )
$$;

revoke all on function public.phoenix_stamp(timestamptz) from public, anon;
revoke all on function public.event_recipients() from public, anon, authenticated;
grant execute on function public.phoenix_stamp(timestamptz) to authenticated;

------------------------------------------------------------------------------
-- Reminders (called by pg_cron every 5 minutes)
------------------------------------------------------------------------------
-- A lead is due while now is inside [start - lead, start - lead + 15 min): the 15 minute window
-- tolerates a late cron tick but means an event created 3 hours out never fires a "24 hours"
-- reminder after the fact. Members choose their leads; the default is 24h and 2h.

create function public.generate_reminders(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  made integer := 0;
  r record;
begin
  for r in
    select e.id as event_id, e.title, e.starts_at, rec.profile_id, ld.minutes as lead_min
    from public.events e
    cross join lateral public.event_recipients() rec
    left join public.notification_prefs np on np.profile_id = rec.profile_id
    cross join lateral unnest(coalesce(np.lead_minutes, '{1440,120}'::integer[])) as ld(minutes)
    where e.status = 'scheduled'
      and e.starts_at > p_now
      and p_now >= e.starts_at - ld.minutes * interval '1 minute'
      and p_now <  e.starts_at - ld.minutes * interval '1 minute' + interval '15 minutes'
  loop
    insert into public.reminder_log (event_id, profile_id, lead_minutes, channel, sent_at)
    values (r.event_id, r.profile_id, r.lead_min, 'in_app', p_now)
    on conflict do nothing;
    if found then
      insert into public.notifications (profile_id, kind, title, body, link)
      values (r.profile_id, 'reminder', r.title, 'Starts ' || public.phoenix_stamp(r.starts_at), '/calendar');
      made := made + 1;
    end if;
  end loop;
  return made;
end;
$$;

------------------------------------------------------------------------------
-- Event changes: new / cancelled / changed
------------------------------------------------------------------------------

create function public.events_notify()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if new.status = 'scheduled' and new.starts_at > now() then
      insert into public.notifications (profile_id, kind, title, body, link)
      select rec.profile_id, 'new', new.title, 'Starts ' || public.phoenix_stamp(new.starts_at), '/calendar'
      from public.event_recipients() rec
      where rec.profile_id is distinct from actor;
    end if;
  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    insert into public.notifications (profile_id, kind, title, body, link)
    select rec.profile_id, 'cancelled', new.title, 'Cancelled. Was ' || public.phoenix_stamp(old.starts_at), '/calendar'
    from public.event_recipients() rec
    where rec.profile_id is distinct from actor;
  elsif new.status = 'scheduled' and new.starts_at is distinct from old.starts_at and new.starts_at > now() then
    -- A moved event gets fresh reminders for its new time.
    delete from public.reminder_log where event_id = new.id;
    insert into public.notifications (profile_id, kind, title, body, link)
    select rec.profile_id, 'changed', new.title, 'Now ' || public.phoenix_stamp(new.starts_at), '/calendar'
    from public.event_recipients() rec
    where rec.profile_id is distinct from actor;
  end if;
  return null;
end;
$$;

create trigger events_notify
  after insert or update on public.events
  for each row execute function public.events_notify();

revoke all on function public.generate_reminders(timestamptz) from public, anon, authenticated;
revoke all on function public.events_notify() from public, anon, authenticated;

------------------------------------------------------------------------------
-- Client RPCs
------------------------------------------------------------------------------

-- Registers this browser for push. A device that moves to another account changes owner.
create function public.register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'approved') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.push_subscriptions (profile_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set profile_id = excluded.profile_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, created_at = now();
end;
$$;

-- Removes this browser's own subscription (the endpoint is not readable by the client, so
-- the delete is by endpoint through this function, and only ever your own row).
create function public.unregister_push_subscription(p_endpoint text)
returns void
language sql security definer set search_path = ''
as $$ delete from public.push_subscriptions where endpoint = p_endpoint and profile_id = auth.uid() $$;

-- One test notification per minute, to yourself.
create function public.send_test_notification()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'approved') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from public.notifications n where n.profile_id = auth.uid() and n.kind = 'test' and n.created_at > now() - interval '1 minute') then
    raise exception 'too_soon' using errcode = 'P0001';
  end if;
  insert into public.notifications (profile_id, kind, title, body, link)
  values (auth.uid(), 'test', 'Test notification', 'Reminders are working on this device.', '/notifications');
end;
$$;

revoke all on function public.register_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.send_test_notification() from public, anon;
revoke all on function public.unregister_push_subscription(text) from public, anon;
grant execute on function public.unregister_push_subscription(text) to authenticated;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.send_test_notification() to authenticated;

------------------------------------------------------------------------------
-- For the Edge Function (service role only)
------------------------------------------------------------------------------
-- Claims unsent notifications (marks them sent first, so a crash can lose a push but never
-- repeats one) and returns a row per push subscription of members who enabled push. Notifications
-- for members without push are closed out here and returned nowhere.

create function public.claim_pushes(p_limit integer default 200)
returns table (notification_id uuid, title text, body text, link text, subscription_id uuid, endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = ''
as $$
begin
  return query
    with claimed as (
      update public.notifications n
         set push_sent_at = now()
       where n.id in (
         select x.id from public.notifications x
          where x.push_sent_at is null and x.created_at > now() - interval '1 day'
          order by x.created_at
          limit least(greatest(p_limit, 1), 500)
          for update skip locked
       )
      returning n.id, n.profile_id, n.title, n.body, n.link
    )
    select c.id, c.title, c.body, c.link, s.id, s.endpoint, s.p256dh, s.auth
    from claimed c
    join public.profiles pr on pr.id = c.profile_id and pr.status = 'approved'
    join public.notification_prefs np on np.profile_id = c.profile_id and np.push_enabled
    join public.push_subscriptions s on s.profile_id = c.profile_id;
end;
$$;

create function public.push_succeeded(p_subscription uuid)
returns void
language sql security definer set search_path = ''
as $$ update public.push_subscriptions set last_success_at = now() where id = p_subscription $$;

create function public.push_gone(p_subscription uuid)
returns void
language sql security definer set search_path = ''
as $$ delete from public.push_subscriptions where id = p_subscription $$;

revoke all on function public.claim_pushes(integer) from public, anon, authenticated;
revoke all on function public.push_succeeded(uuid) from public, anon, authenticated;
revoke all on function public.push_gone(uuid) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_pushes(integer) to service_role;
    grant execute on function public.push_succeeded(uuid) to service_role;
    grant execute on function public.push_gone(uuid) to service_role;
  end if;
end;
$$;

------------------------------------------------------------------------------
-- Grants and RLS
------------------------------------------------------------------------------

revoke all on public.notification_prefs, public.push_subscriptions, public.notifications, public.reminder_log
  from anon, authenticated;

grant select on public.notification_prefs to authenticated;
grant insert (profile_id, push_enabled, lead_minutes) on public.notification_prefs to authenticated;
grant update (push_enabled, lead_minutes) on public.notification_prefs to authenticated;

grant select (id, created_at, last_success_at, user_agent) on public.push_subscriptions to authenticated;
grant delete on public.push_subscriptions to authenticated;

grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

alter table public.notification_prefs enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notifications enable row level security;
alter table public.reminder_log enable row level security;

create policy notification_prefs_select on public.notification_prefs
  for select to authenticated using (profile_id = (select auth.uid()));
create policy notification_prefs_insert on public.notification_prefs
  for insert to authenticated with check (profile_id = (select auth.uid()) and public.current_user_is_approved());
create policy notification_prefs_update on public.notification_prefs
  for update to authenticated
  using (profile_id = (select auth.uid())) with check (profile_id = (select auth.uid()));

create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated using (profile_id = (select auth.uid()));
create policy push_subscriptions_delete on public.push_subscriptions
  for delete to authenticated using (profile_id = (select auth.uid()));

create policy notifications_select on public.notifications
  for select to authenticated using (profile_id = (select auth.uid()));
create policy notifications_update on public.notifications
  for update to authenticated
  using (profile_id = (select auth.uid())) with check (profile_id = (select auth.uid()));

-- reminder_log: RLS on, no policies, no grants. Only the definer functions touch it.

------------------------------------------------------------------------------
-- Schedule generate_reminders() every 5 minutes where pg_cron is available.
------------------------------------------------------------------------------
-- (Delivery is a second job that calls the Edge Function; it needs the project URL and a key, so
-- it is set up per environment by hand. See docs/DEPLOY.md.)

do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron is not available here; schedule public.generate_reminders() every 5 minutes by hand';
    return;
  end;
  perform cron.unschedule(jobid) from cron.job where jobname = 'generate-reminders';
  perform cron.schedule('generate-reminders', '*/5 * * * *', 'select public.generate_reminders()');
exception when others then
  raise notice 'could not schedule generate-reminders (%)', sqlerrm;
end;
$$;
