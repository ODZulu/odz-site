-- MVA-233: Command motions and votes. One generic motion-and-vote engine, so any feature can ask
-- Command (or the Old Guard) to decide a matter and read back a recorded result.
--
-- Shape (also meets Lord's 2026-11-02 design note on the ticket, so MVA-245/246 need no rework):
--   * motions: type, title, description, linked subject (subject_type + subject_id), an optional
--     parent record (parent_type + parent_id, e.g. an agenda item), options (jsonb, default
--     Approve/Reject), eligible body, deadline, and TWO explicit fields: state (draft / open /
--     closed) and status (open / decided / escalated / escalated_final / withdrawn).
--   * Rounds. round 1 is the opening body (Command by default). A tie, or fewer than 3 eligible
--     voters, escalates the SAME motion to round 2 (Old Guard, Command counted inside it); a tie or
--     fewer than 3 there ends in status escalated_final, which only an Admin closes by recording an
--     explicit outcome and reason (decide_motion_final). Every step is in motion_log.
--   * Snapshots. motion_voters holds the eligible voters of each round, written when the round
--     starts (never recomputed on read): members of the body, minus parties and anyone who recused
--     in an earlier round. A self-recusal removes the voter from the current snapshot.
--   * Votes are open ballot, by name. motion_votes holds the current choice (one row per voter per
--     round); every cast and change is also appended to motion_log (who, when, before/after, with a
--     callsign snapshot). Votes, parties, recusals, the log and motions can never be deleted, and
--     the log can never be edited (triggers). The profile columns carry no foreign key on purpose,
--     so hard-deleting a removed member (MVA-209) cannot erase a recorded vote.
--   * All writes go through SECURITY DEFINER RPCs; clients have SELECT only. Who sees a motion:
--     Old Guard and Command (tiers.seat_group), Admin, and its parties. A draft is seen only by its
--     opener, Command and Admin.
--   * The rules (motion_evaluate): a strict majority of the round's eligible voters on one option
--     decides it, early if that happens before the deadline. If no option can still reach a strict
--     majority, or the deadline passes without one, the round is a tie and escalates. process_motions()
--     (pg_cron every 5 minutes where available; also callable by any member, it is idempotent and
--     only acts on due motions) closes lapsed rounds and sends the 24-hour reminder.
--   * Subject features read the outcome with motion_result(); they open motions with
--     open_motion() (capability open_motions, Command by default, Admin passes). Feature
--     integrations (MVA-232) are separate tickets.
--
-- "Team Lead" is not modelled anywhere in the schema (no tier, designation or flag), so the final
-- step of the ladder is built as the spec's last fallback: an Admin records the outcome. The
-- Team Lead -> XO -> Admin ordering is flagged on the PR for Dax.
--
-- Additive only: nine new tables, one capability, one notifications kind, new functions. No
-- existing row is rewritten (the notifications check constraint is widened, not data touched).

------------------------------------------------------------------------------
-- Capability: who may open a motion (Command by default; Admin passes every check)
------------------------------------------------------------------------------

insert into public.capabilities (key, description)
values ('open_motions', 'Open a Command motion for a vote (Command)');

insert into public.tier_capabilities (tier_id, capability_key)
select t.id, 'open_motions' from public.tiers t where t.seat_group = 'command';

------------------------------------------------------------------------------
-- Notifications: one new kind
------------------------------------------------------------------------------

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in ('reminder', 'new', 'cancelled', 'changed', 'test', 'motion'));

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

create table public.motions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type ~ '^[a-z][a-z0-9_]{0,39}$'),
  title text not null check (length(btrim(title)) between 3 and 120),
  description text not null default '' check (length(description) <= 2000),
  subject_type text check (subject_type is null or subject_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  subject_id uuid,
  parent_type text check (parent_type is null or parent_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  parent_id uuid,
  options jsonb not null default '["Approve", "Reject"]'::jsonb,
  body text not null default 'command' check (body in ('command', 'old_guard')),      -- body of the current round
  round smallint not null default 1 check (round between 1 and 2),
  deadline_hours integer not null default 72 check (deadline_hours between 1 and 720),
  deadline timestamptz,                                                                -- set when the round opens
  state text not null default 'open' check (state in ('draft', 'open', 'closed')),
  status text not null default 'open' check (status in ('open', 'decided', 'escalated', 'escalated_final', 'withdrawn')),
  opened_by uuid not null,
  opened_by_callsign text,
  opened_at timestamptz,
  outcome_option text,
  decided_at timestamptz,
  decided_final_by uuid,                       -- set only when an Admin recorded the outcome
  decided_final_reason text check (decided_final_reason is null or length(decided_final_reason) between 3 and 500),
  withdraw_reason text check (withdraw_reason is null or length(withdraw_reason) between 3 and 300),
  reminded_round smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint motions_options_shape check (
    jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 6
  ),
  constraint motions_subject_pair check ((subject_type is null) = (subject_id is null)),
  constraint motions_parent_pair check ((parent_type is null) = (parent_id is null)),
  constraint motions_closed_status check (
    (state = 'closed') = (status in ('decided', 'withdrawn'))
  )
);

create index motions_state_idx on public.motions (state, deadline);
create index motions_subject_idx on public.motions (subject_type, subject_id) where subject_id is not null;
create index motions_parent_idx on public.motions (parent_type, parent_id) where parent_id is not null;

create table public.motion_parties (
  motion_id uuid not null references public.motions (id),
  profile_id uuid not null,
  primary key (motion_id, profile_id)
);

-- Eligible voters per round (the snapshot). A recusal removes the row for that round.
create table public.motion_voters (
  motion_id uuid not null references public.motions (id),
  round smallint not null,
  profile_id uuid not null,
  primary key (motion_id, round, profile_id)
);

create table public.motion_recusals (
  motion_id uuid not null references public.motions (id),
  profile_id uuid not null,
  callsign text,
  round smallint not null,
  reason text not null check (length(reason) between 3 and 300),
  created_at timestamptz not null default now(),
  primary key (motion_id, profile_id)
);

create table public.motion_votes (
  motion_id uuid not null references public.motions (id),
  round smallint not null,
  voter_id uuid not null,
  voter_callsign text,
  option text not null,
  updated_at timestamptz not null default now(),
  primary key (motion_id, round, voter_id)
);

-- Append-only record of everything that happens to a motion.
create table public.motion_log (
  id uuid primary key default gen_random_uuid(),
  motion_id uuid not null references public.motions (id),
  round smallint not null,
  action text not null check (action in (
    'created', 'opened', 'vote', 'vote_changed', 'recused', 'escalated', 'decided', 'final_decided', 'withdrawn'
  )),
  actor_id uuid,
  actor_callsign text,
  option_from text,
  option_to text,
  detail text check (detail is null or length(detail) <= 600),
  created_at timestamptz not null default now()
);

create index motion_log_motion_idx on public.motion_log (motion_id, created_at);

------------------------------------------------------------------------------
-- Visibility
------------------------------------------------------------------------------
-- Seat holders (Old Guard and Command), Admin, and the motion's own parties. A draft is seen only
-- by its opener, Command and Admin. Anon sees nothing (no grant, no policy).

create function public.can_see_motion(p_motion uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.motions m
    join public.profiles me on me.id = auth.uid() and me.status = 'approved'
    left join public.tiers t on t.id = me.tier_id
    where m.id = p_motion
      and (
        me.is_admin
        or (m.state = 'draft' and (m.opened_by = me.id or t.seat_group = 'command'))
        or (m.state <> 'draft' and t.seat_group is not null)
        or (m.state <> 'draft' and exists (
          select 1 from public.motion_parties mp where mp.motion_id = m.id and mp.profile_id = me.id
        ))
      )
  );
$$;

revoke all on function public.can_see_motion(uuid) from public, anon;
grant execute on function public.can_see_motion(uuid) to authenticated;

------------------------------------------------------------------------------
-- RLS: read-only for clients; every write is an RPC
------------------------------------------------------------------------------

revoke all on public.motions, public.motion_parties, public.motion_voters, public.motion_recusals,
  public.motion_votes, public.motion_log from anon, authenticated;
grant select on public.motions, public.motion_parties, public.motion_voters, public.motion_recusals,
  public.motion_votes, public.motion_log to authenticated;

alter table public.motions enable row level security;
alter table public.motion_parties enable row level security;
alter table public.motion_voters enable row level security;
alter table public.motion_recusals enable row level security;
alter table public.motion_votes enable row level security;
alter table public.motion_log enable row level security;

create policy motions_select on public.motions
  for select to authenticated using (public.can_see_motion(id));
create policy motion_parties_select on public.motion_parties
  for select to authenticated using (public.can_see_motion(motion_id));
create policy motion_voters_select on public.motion_voters
  for select to authenticated using (public.can_see_motion(motion_id));
create policy motion_recusals_select on public.motion_recusals
  for select to authenticated using (public.can_see_motion(motion_id));
create policy motion_votes_select on public.motion_votes
  for select to authenticated using (public.can_see_motion(motion_id));
create policy motion_log_select on public.motion_log
  for select to authenticated using (public.can_see_motion(motion_id));
-- No insert/update/delete policy anywhere: only the RPCs below write these tables.

------------------------------------------------------------------------------
-- Nothing is ever deleted; the log is never edited
------------------------------------------------------------------------------

create function public.motion_immutable()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'motion records are permanent' using errcode = '42501';
end;
$$;

revoke all on function public.motion_immutable() from public, anon, authenticated;

create trigger motions_no_delete before delete on public.motions
  for each row execute function public.motion_immutable();
create trigger motion_parties_no_delete before delete on public.motion_parties
  for each row execute function public.motion_immutable();
create trigger motion_recusals_no_delete before delete on public.motion_recusals
  for each row execute function public.motion_immutable();
create trigger motion_votes_no_delete before delete on public.motion_votes
  for each row execute function public.motion_immutable();
create trigger motion_log_no_change before update or delete on public.motion_log
  for each row execute function public.motion_immutable();
-- motion_voters is the working snapshot: a recusal removes the recused voter from it, so rows may
-- be deleted (by motion_recuse only; clients have no DELETE grant). It records no choices.

------------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
------------------------------------------------------------------------------

create function public.motion_log_add(
  p_motion uuid, p_round smallint, p_action text, p_actor uuid,
  p_from text default null, p_to text default null, p_detail text default null
) returns void
language sql security definer set search_path = ''
as $$
  insert into public.motion_log (motion_id, round, action, actor_id, actor_callsign, option_from, option_to, detail)
  values (p_motion, p_round, p_action, p_actor,
          (select callsign from public.profiles where id = p_actor), p_from, p_to, p_detail);
$$;

-- Who is told about a motion: seat holders and parties (approved accounts only).
create function public.motion_audience(p_motion uuid)
returns table (profile_id uuid)
language sql stable security definer set search_path = ''
as $$
  select p.id
  from public.profiles p
  left join public.tiers t on t.id = p.tier_id
  where p.status = 'approved'
    and (
      t.seat_group is not null
      or exists (select 1 from public.motion_parties mp where mp.motion_id = p_motion and mp.profile_id = p.id)
    )
$$;

create function public.motion_notify(p_profiles uuid[], p_title text, p_body text, p_motion uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.notifications (profile_id, kind, title, body, link)
  select p.id, 'motion', left(p_title, 200), left(p_body, 300), '/motions/' || p_motion::text
  from public.profiles p
  where p.id = any (p_profiles) and p.status = 'approved';
$$;

-- Members of a body who may vote on this motion: approved, in the body, not a party, not a prior recusal.
create function public.motion_eligible(p_motion uuid, p_body text)
returns table (profile_id uuid)
language sql stable security definer set search_path = ''
as $$
  select p.id
  from public.profiles p
  join public.tiers t on t.id = p.tier_id
  where p.status = 'approved'
    and (
      (p_body = 'command' and t.seat_group = 'command')
      or (p_body = 'old_guard' and t.seat_group in ('command', 'old_guard'))
    )
    and not exists (select 1 from public.motion_parties mp where mp.motion_id = p_motion and mp.profile_id = p.id)
    and not exists (select 1 from public.motion_recusals mr where mr.motion_id = p_motion and mr.profile_id = p.id)
$$;

revoke all on function public.motion_log_add(uuid, smallint, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.motion_audience(uuid) from public, anon, authenticated;
revoke all on function public.motion_notify(uuid[], text, text, uuid) from public, anon, authenticated;
revoke all on function public.motion_eligible(uuid, text) from public, anon, authenticated;

-- Starts the current round: snapshot the eligible voters, set the deadline, tell them.
create function public.motion_start_round(p_motion uuid, p_actor uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m public.motions;
  voters uuid[];
begin
  select * into m from public.motions where id = p_motion for update;
  insert into public.motion_voters (motion_id, round, profile_id)
  select p_motion, m.round, e.profile_id from public.motion_eligible(p_motion, m.body) e;
  select coalesce(array_agg(v.profile_id), '{}') into voters
  from public.motion_voters v where v.motion_id = p_motion and v.round = m.round;
  update public.motions set deadline = now() + make_interval(hours => m.deadline_hours) where id = p_motion;
  perform public.motion_notify(
    voters,
    'Vote needed: ' || m.title,
    case when m.round = 1 then 'A motion is open for your vote.' else 'A motion escalated to the Old Guard needs your vote.' end,
    p_motion
  );
end;
$$;

revoke all on function public.motion_start_round(uuid, uuid) from public, anon, authenticated;

-- Ends the current round without a result: round 1 goes to the Old Guard, anything else to the
-- Admin. Called only from motion_evaluate().
create function public.motion_escalate(p_motion uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m public.motions;
begin
  select * into m from public.motions where id = p_motion for update;
  if m.body = 'command' then
    update public.motions
      set body = 'old_guard', round = 2, status = 'escalated', deadline = null
    where id = p_motion;
    perform public.motion_log_add(p_motion, 2::smallint, 'escalated', null, null, null,
      p_reason || ': escalated to a vote of the Old Guard');
    perform public.motion_start_round(p_motion, null);
    perform public.motion_notify(
      (select coalesce(array_agg(a.profile_id), '{}') from public.motion_audience(p_motion) a),
      'Escalated: ' || m.title, 'No decision from Command; the Old Guard now votes.', p_motion);
    perform public.motion_evaluate(p_motion);
  else
    update public.motions set status = 'escalated_final', deadline = null where id = p_motion;
    perform public.motion_log_add(p_motion, m.round, 'escalated', null, null, null,
      p_reason || ': no decision from the Old Guard; an Admin records the outcome');
    perform public.motion_notify(
      (select coalesce(array_agg(a.profile_id), '{}') from public.motion_audience(p_motion) a),
      'Awaiting final decision: ' || m.title, 'The Old Guard could not decide; an Admin records the outcome.', p_motion);
  end if;
end;
$$;

revoke all on function public.motion_escalate(uuid, text) from public, anon, authenticated;

-- The whole rule set, in one place. Safe to call at any time: it only acts when the round is
-- settled, impossible to settle, or past its deadline.
create function public.motion_evaluate(p_motion uuid, p_now timestamptz default now())
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m public.motions;
  n integer;
  voted integer;
  remaining integer;
  winner text;
  can_still_win boolean;
begin
  select * into m from public.motions where id = p_motion for update;
  if not found or m.state <> 'open' or m.status not in ('open', 'escalated') then
    return;
  end if;

  select count(*) into n from public.motion_voters where motion_id = p_motion and round = m.round;
  if n < 3 then
    perform public.motion_escalate(p_motion, 'fewer than 3 eligible voters');
    return;
  end if;

  select count(*) into voted from public.motion_votes where motion_id = p_motion and round = m.round;
  remaining := n - voted;

  -- A strict majority of ALL eligible voters on one option decides it, at once.
  select o.val into winner
  from jsonb_array_elements_text(m.options) as o(val)
  where (select count(*) from public.motion_votes v
         where v.motion_id = p_motion and v.round = m.round and v.option = o.val) * 2 > n
  limit 1;

  if winner is not null then
    update public.motions
      set state = 'closed', status = 'decided', outcome_option = winner, decided_at = now(), deadline = null
    where id = p_motion;
    perform public.motion_log_add(p_motion, m.round, 'decided', null, null, winner, 'strict majority of eligible voters');
    perform public.motion_notify(
      (select coalesce(array_agg(a.profile_id), '{}') from public.motion_audience(p_motion) a),
      'Decided: ' || m.title, 'Result: ' || winner, p_motion);
    return;
  end if;

  -- Is a strict majority still possible for any option?
  select exists (
    select 1 from jsonb_array_elements_text(m.options) as o(val)
    where ((select count(*) from public.motion_votes v
            where v.motion_id = p_motion and v.round = m.round and v.option = o.val) + remaining) * 2 > n
  ) into can_still_win;

  if not can_still_win then
    perform public.motion_escalate(p_motion, 'no option can reach a majority');
  elsif m.deadline is not null and p_now >= m.deadline then
    perform public.motion_escalate(p_motion, 'deadline passed without a majority');
  end if;
end;
$$;

revoke all on function public.motion_evaluate(uuid, timestamptz) from public, anon, authenticated;

-- Shared creation path (open_motion() below checks the capability; features that call this from
-- their own SECURITY DEFINER functions have already checked theirs).
create function public.motion_create(
  p_actor uuid, p_type text, p_title text, p_description text,
  p_subject_type text, p_subject_id uuid, p_options jsonb, p_body text,
  p_deadline_hours integer, p_parties uuid[], p_parent_type text, p_parent_id uuid, p_draft boolean
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  opts jsonb := coalesce(p_options, '["Approve", "Reject"]'::jsonb);
  new_id uuid;
begin
  if jsonb_typeof(opts) <> 'array'
     or jsonb_array_length(opts) not between 2 and 6
     or exists (
       select 1 from jsonb_array_elements(opts) e
       where jsonb_typeof(e) <> 'string' or length(btrim(e #>> '{}')) not between 1 and 40
     )
     or (select count(distinct e #>> '{}') from jsonb_array_elements(opts) e) <> jsonb_array_length(opts) then
    raise exception 'bad_options' using errcode = 'P0001';
  end if;
  if p_body not in ('command', 'old_guard') then
    raise exception 'bad_body' using errcode = 'P0001';
  end if;

  insert into public.motions (
    type, title, description, subject_type, subject_id, parent_type, parent_id, options, body,
    deadline_hours, state, status, opened_by, opened_by_callsign
  ) values (
    p_type, btrim(p_title), coalesce(p_description, ''), p_subject_type, p_subject_id, p_parent_type, p_parent_id,
    opts, p_body, coalesce(p_deadline_hours, 72), case when p_draft then 'draft' else 'open' end, 'open',
    p_actor, (select callsign from public.profiles where id = p_actor)
  ) returning id into new_id;

  insert into public.motion_parties (motion_id, profile_id)
  select new_id, x from unnest(coalesce(p_parties, '{}'::uuid[])) as x
  where exists (select 1 from public.profiles where id = x)
  on conflict do nothing;

  perform public.motion_log_add(new_id, 1::smallint, 'created', p_actor, null, null, p_title);

  if not p_draft then
    update public.motions set opened_at = now() where id = new_id;
    perform public.motion_log_add(new_id, 1::smallint, 'opened', p_actor);
    perform public.motion_start_round(new_id, p_actor);
    perform public.motion_evaluate(new_id);
  end if;
  return new_id;
end;
$$;

revoke all on function public.motion_create(uuid, text, text, text, text, uuid, jsonb, text, integer, uuid[], text, uuid, boolean)
  from public, anon, authenticated;

------------------------------------------------------------------------------
-- Client RPCs
------------------------------------------------------------------------------

create function public.open_motion(
  p_type text, p_title text, p_description text default '',
  p_subject_type text default null, p_subject_id uuid default null,
  p_options jsonb default null, p_body text default 'command', p_deadline_hours integer default 72,
  p_parties uuid[] default '{}', p_parent_type text default null, p_parent_id uuid default null,
  p_draft boolean default false
) returns uuid
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_capability('open_motions') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return public.motion_create(auth.uid(), p_type, p_title, p_description, p_subject_type, p_subject_id,
    p_options, p_body, p_deadline_hours, p_parties, p_parent_type, p_parent_id, p_draft);
end;
$$;

revoke all on function public.open_motion(text, text, text, text, uuid, jsonb, text, integer, uuid[], text, uuid, boolean)
  from public, anon;
grant execute on function public.open_motion(text, text, text, text, uuid, jsonb, text, integer, uuid[], text, uuid, boolean)
  to authenticated;

-- Opens a draft: the eligible voters are snapshotted now, not when the draft was written.
create function public.start_motion(p_motion uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m public.motions;
begin
  select * into m from public.motions where id = p_motion for update;
  if not found or not public.can_see_motion(p_motion) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if not (m.opened_by = auth.uid() or public.has_capability('open_motions')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if m.state <> 'draft' then
    raise exception 'not_a_draft' using errcode = 'P0001';
  end if;
  update public.motions set state = 'open', opened_at = now() where id = p_motion;
  perform public.motion_log_add(p_motion, 1::smallint, 'opened', auth.uid());
  perform public.motion_start_round(p_motion, auth.uid());
  perform public.motion_evaluate(p_motion);
end;
$$;

revoke all on function public.start_motion(uuid) from public, anon;
grant execute on function public.start_motion(uuid) to authenticated;

create function public.cast_vote(p_motion uuid, p_option text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m public.motions;
  me public.profiles;
  prior text;
begin
  select * into m from public.motions where id = p_motion for update;
  if not found or not public.can_see_motion(p_motion) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  -- A lapsed round is settled first, so nobody votes after the deadline.
  perform public.motion_evaluate(p_motion);
  select * into m from public.motions where id = p_motion;
  if m.state <> 'open' or m.status not in ('open', 'escalated') then
    raise exception 'motion_closed' using errcode = 'P0001';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(m.options) o where o = p_option) then
    raise exception 'bad_option' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.motion_voters v
    where v.motion_id = p_motion and v.round = m.round and v.profile_id = auth.uid()
  ) then
    raise exception 'not_eligible' using errcode = '42501';
  end if;

  select * into me from public.profiles where id = auth.uid();
  select v.option into prior from public.motion_votes v
  where v.motion_id = p_motion and v.round = m.round and v.voter_id = auth.uid();

  if prior is not null and prior = p_option then
    return;                                         -- same choice: nothing to record
  end if;

  insert into public.motion_votes (motion_id, round, voter_id, voter_callsign, option)
  values (p_motion, m.round, auth.uid(), me.callsign, p_option)
  on conflict (motion_id, round, voter_id)
  do update set option = excluded.option, updated_at = now();

  perform public.motion_log_add(p_motion, m.round,
    case when prior is null then 'vote' else 'vote_changed' end, auth.uid(), prior, p_option);
  perform public.motion_evaluate(p_motion);
end;
$$;

revoke all on function public.cast_vote(uuid, text) from public, anon;
grant execute on function public.cast_vote(uuid, text) to authenticated;

-- Self-recusal. Only an eligible voter who has not voted in this round; the reason is logged.
create function public.recuse_from_motion(p_motion uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m public.motions;
begin
  select * into m from public.motions where id = p_motion for update;
  if not found or not public.can_see_motion(p_motion) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if m.state <> 'open' or m.status not in ('open', 'escalated') then
    raise exception 'motion_closed' using errcode = 'P0001';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 then
    raise exception 'bad_reason' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.motion_voters v
    where v.motion_id = p_motion and v.round = m.round and v.profile_id = auth.uid()
  ) then
    raise exception 'not_eligible' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.motion_votes v
    where v.motion_id = p_motion and v.round = m.round and v.voter_id = auth.uid()
  ) then
    raise exception 'already_voted' using errcode = 'P0001';
  end if;

  delete from public.motion_voters
  where motion_id = p_motion and round = m.round and profile_id = auth.uid();
  insert into public.motion_recusals (motion_id, profile_id, callsign, round, reason)
  values (p_motion, auth.uid(), (select callsign from public.profiles where id = auth.uid()), m.round, btrim(p_reason));
  perform public.motion_log_add(p_motion, m.round, 'recused', auth.uid(), null, null, btrim(p_reason));
  perform public.motion_evaluate(p_motion);
end;
$$;

revoke all on function public.recuse_from_motion(uuid, text) from public, anon;
grant execute on function public.recuse_from_motion(uuid, text) to authenticated;

-- Withdraw: the opener or Command (or Admin), with a reason, and only while no vote exists.
create function public.withdraw_motion(p_motion uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m public.motions;
  is_command boolean;
begin
  select * into m from public.motions where id = p_motion for update;
  if not found or not public.can_see_motion(p_motion) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  select (public.current_user_is_admin() or exists (
    select 1 from public.profiles p join public.tiers t on t.id = p.tier_id
    where p.id = auth.uid() and p.status = 'approved' and t.seat_group = 'command'
  )) into is_command;
  if not (m.opened_by = auth.uid() or is_command) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if m.state = 'closed' then
    raise exception 'motion_closed' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.motion_votes v where v.motion_id = p_motion) then
    raise exception 'votes_cast' using errcode = 'P0001';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 then
    raise exception 'bad_reason' using errcode = 'P0001';
  end if;

  update public.motions
    set state = 'closed', status = 'withdrawn', withdraw_reason = btrim(p_reason), deadline = null
  where id = p_motion;
  perform public.motion_log_add(p_motion, m.round, 'withdrawn', auth.uid(), null, null, btrim(p_reason));
  perform public.motion_notify(
    (select coalesce(array_agg(a.profile_id), '{}') from public.motion_audience(p_motion) a),
    'Withdrawn: ' || m.title, 'The motion was withdrawn.', p_motion);
end;
$$;

revoke all on function public.withdraw_motion(uuid, text) from public, anon;
grant execute on function public.withdraw_motion(uuid, text) to authenticated;

-- Last step of the ladder: an Admin records an explicit outcome and a reason.
create function public.decide_motion_final(p_motion uuid, p_option text, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m public.motions;
begin
  if not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into m from public.motions where id = p_motion for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if m.state <> 'open' or m.status <> 'escalated_final' then
    raise exception 'not_awaiting_final' using errcode = 'P0001';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(m.options) o where o = p_option) then
    raise exception 'bad_option' using errcode = 'P0001';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'bad_reason' using errcode = 'P0001';
  end if;

  update public.motions
    set state = 'closed', status = 'decided', outcome_option = p_option, decided_at = now(),
        decided_final_by = auth.uid(), decided_final_reason = btrim(p_reason), deadline = null
  where id = p_motion;
  perform public.motion_log_add(p_motion, m.round, 'final_decided', auth.uid(), null, p_option, btrim(p_reason));
  perform public.motion_notify(
    (select coalesce(array_agg(a.profile_id), '{}') from public.motion_audience(p_motion) a),
    'Decided: ' || m.title, 'Result: ' || p_option || ' (recorded by an Admin)', p_motion);
end;
$$;

revoke all on function public.decide_motion_final(uuid, text, text) from public, anon;
grant execute on function public.decide_motion_final(uuid, text, text) to authenticated;

-- Time-driven work: close lapsed rounds, send the 24-hour reminder to voters who have not voted.
-- Idempotent and only acts on due motions, so any signed-in member may call it (the Motions page
-- does, which keeps dev working without pg_cron).
create function public.process_motions(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  done integer := 0;
begin
  if auth.uid() is not null and not public.current_user_is_approved() then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  for r in
    select m.id from public.motions m
    where m.state = 'open' and m.status in ('open', 'escalated') and m.deadline is not null and m.deadline <= p_now
  loop
    perform public.motion_evaluate(r.id, p_now);
    done := done + 1;
  end loop;

  for r in
    select m.id, m.title, m.round from public.motions m
    where m.state = 'open' and m.status in ('open', 'escalated') and m.deadline is not null
      and m.deadline_hours > 24 and m.reminded_round < m.round
      and p_now >= m.deadline - interval '24 hours' and p_now < m.deadline
  loop
    perform public.motion_notify(
      (select coalesce(array_agg(v.profile_id), '{}') from public.motion_voters v
       where v.motion_id = r.id and v.round = r.round
         and not exists (select 1 from public.motion_votes x
                         where x.motion_id = r.id and x.round = r.round and x.voter_id = v.profile_id)),
      'Vote closes in 24 hours: ' || r.title, 'You have not voted yet.', r.id);
    update public.motions set reminded_round = r.round where id = r.id;
    done := done + 1;
  end loop;
  return done;
end;
$$;

revoke all on function public.process_motions(timestamptz) from public, anon;
grant execute on function public.process_motions(timestamptz) to authenticated;

------------------------------------------------------------------------------
-- Hooks for subject features
------------------------------------------------------------------------------

-- The result of a motion, for the feature that asked for it. Returns nothing to a caller who may
-- not see the motion. 'final' is true when an Admin recorded the outcome.
create function public.motion_result(p_motion uuid)
returns table (status text, outcome_option text, decided_at timestamptz, final boolean)
language sql stable security definer set search_path = ''
as $$
  select m.status, m.outcome_option, m.decided_at, m.decided_final_by is not null
  from public.motions m
  where m.id = p_motion and public.can_see_motion(m.id)
$$;

-- Motions linked to a subject (e.g. one expense dispute), newest first.
create function public.motions_for_subject(p_subject_type text, p_subject_id uuid)
returns table (id uuid, title text, state text, status text, outcome_option text)
language sql stable security definer set search_path = ''
as $$
  select m.id, m.title, m.state, m.status, m.outcome_option
  from public.motions m
  where m.subject_type = p_subject_type and m.subject_id = p_subject_id and public.can_see_motion(m.id)
  order by m.created_at desc
$$;

revoke all on function public.motion_result(uuid) from public, anon;
revoke all on function public.motions_for_subject(text, uuid) from public, anon;
grant execute on function public.motion_result(uuid) to authenticated;
grant execute on function public.motions_for_subject(text, uuid) to authenticated;

------------------------------------------------------------------------------
-- Schedule process_motions() every 5 minutes where pg_cron is available
------------------------------------------------------------------------------

do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron is not available here; schedule public.process_motions() every 5 minutes by hand';
    return;
  end;
  perform cron.unschedule(jobid) from cron.job where jobname = 'process-motions';
  perform cron.schedule('process-motions', '*/5 * * * *', 'select public.process_motions()');
exception when others then
  raise notice 'could not schedule process-motions (%)', sqlerrm;
end;
$$;
