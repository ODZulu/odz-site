-- MVA-246: live meeting votes. During a meeting the chair opens a vote item of a published agenda
-- (MVA-245) as a motion (MVA-233), eligible voters cast Yes / No / Abstain from their phones, the
-- chair closes it, and the result is written into the minutes by name.
--
-- Built on the motion engine rather than beside it: an agenda vote is a motion with
-- mode = 'live', body = Old Guard (Command counted inside it), parent = the agenda item, options
-- Yes / No / Abstain. What differs from a standard motion:
--   * No deadline and no early close. Only the chair closes it (close_live_vote), so the engine's
--     motion_evaluate() does nothing for a live motion.
--   * Choices are hidden until the chair closes (spec default; Dax to confirm the alternative of a
--     live tally). While open a voter reads only their own choice plus a count of how many have
--     voted (live_vote_progress); the vote rows and the vote entries of the log are closed to
--     everyone else, the chair and Admin included. On close they are revealed.
--   * Result by the D27 rule: strict majority of ALL eligible voters. Yes majority = passed, No
--     majority = failed, anything else = tie. Quorum is a setting with NO default
--     (meeting_vote_settings.quorum is null until an Admin sets it): when set, fewer votes cast
--     (abstentions count as cast) than the quorum = no_quorum, which closes the vote with no
--     outcome. A tie, or fewer than 3 eligible voters, escalates as in MVA-233: the body is already
--     the Old Guard, so it waits (escalated_final) for an Admin to record the outcome.
--   * The eligible list is snapshotted when voting opens (the engine's motion_voters): Old Guard
--     and Command, minus the motion's parties and recused members; soft-removed and Retired
--     members are not approved accounts and are excluded. The motion wording is frozen when the
--     vote opens (agenda_items_prepare refuses to change it afterwards).
--   * Consulted members get an advisory poll on the same item (motion_consulted snapshot,
--     motion_advisory_votes). It is recorded separately, hidden while open, and never counts
--     toward the result. Default consulted: approved accounts that hold read_event_details (Member
--     and above), are not role-based (Support) and are not in the voting body; the chair may pass
--     an explicit tier list instead.
--   * The chair can record a vote for a voter who is present but cannot use the app
--     (record_vote_for): flagged "recorded by chair" with a required note, shown that way in the
--     record. A voter's own vote cannot be overwritten that way, and a chair-recorded vote cannot be
--     changed by a later self-cast.
--   * A closed vote cannot be reopened or edited; a correction is a new motion referencing the old
--     one. Withdrawing before any vote (MVA-233) frees the item for a fresh vote.
--   * create_minutes_from_agenda() now adds, for each closed live vote: the result, every voter's
--     choice by name, chair-recorded flags and the advisory counts.
--
-- Redefines (each starts from the newest definition, named here): can_see_motion() and
-- motion_evaluate() and cast_vote() from 20261103150000_motions.sql, agenda_items_prepare() and
-- create_minutes_from_agenda() from 20261103160000_meeting_agendas.sql. Additive otherwise:
-- columns on motions and motion_votes, three tables, a one-row settings table, new functions,
-- and two widened check constraints / replaced policies.

------------------------------------------------------------------------------
-- Columns, constraint changes
------------------------------------------------------------------------------

alter table public.motions
  add column mode text not null default 'standard' check (mode in ('standard', 'live')),
  add column live_closed_at timestamptz,
  add column live_result text check (live_result is null or live_result in ('passed', 'failed', 'tie', 'no_quorum')),
  add column quorum_at_open integer;

alter table public.motion_votes
  add column recorded_by uuid,
  add column record_note text check (record_note is null or length(record_note) between 3 and 300);

alter table public.motion_log drop constraint motion_log_action_check;
alter table public.motion_log
  add constraint motion_log_action_check
  check (action in (
    'created', 'opened', 'vote', 'vote_changed', 'recused', 'escalated', 'decided', 'final_decided', 'withdrawn',
    'chair_vote', 'advisory_vote', 'live_closed'
  ));

------------------------------------------------------------------------------
-- Quorum setting: one row, no default
------------------------------------------------------------------------------

create table public.meeting_vote_settings (
  singleton boolean primary key default true check (singleton),
  quorum integer check (quorum is null or quorum between 1 and 100),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.meeting_vote_settings (singleton, quorum) values (true, null);

revoke all on public.meeting_vote_settings from anon, authenticated;
grant select on public.meeting_vote_settings to authenticated;
alter table public.meeting_vote_settings enable row level security;
create policy meeting_vote_settings_select on public.meeting_vote_settings
  for select to authenticated using (public.current_user_is_approved());

create function public.set_vote_quorum(p_quorum integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  old_q integer;
begin
  if not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_quorum is not null and p_quorum not between 1 and 100 then
    raise exception 'bad_quorum' using errcode = 'P0001';
  end if;
  select quorum into old_q from public.meeting_vote_settings where singleton;
  if old_q is not distinct from p_quorum then
    return;
  end if;
  update public.meeting_vote_settings set quorum = p_quorum, updated_at = now(), updated_by = auth.uid() where singleton;
  insert into public.settings_audit (actor_id, event, target, detail)
  values (auth.uid(), 'vote_quorum_changed', 'meeting votes',
          coalesce(old_q::text, 'none') || ' -> ' || coalesce(p_quorum::text, 'none'));
end;
$$;

revoke all on function public.set_vote_quorum(integer) from public, anon;
grant execute on function public.set_vote_quorum(integer) to authenticated;

------------------------------------------------------------------------------
-- Consulted members and the advisory poll
------------------------------------------------------------------------------

create table public.motion_consulted (
  motion_id uuid not null references public.motions (id),
  profile_id uuid not null,
  primary key (motion_id, profile_id)
);

create table public.motion_advisory_votes (
  motion_id uuid not null references public.motions (id),
  profile_id uuid not null,
  callsign text,
  option text not null,
  updated_at timestamptz not null default now(),
  primary key (motion_id, profile_id)
);

create trigger motion_consulted_no_delete before delete on public.motion_consulted
  for each row execute function public.motion_immutable();
create trigger motion_advisory_votes_no_delete before delete on public.motion_advisory_votes
  for each row execute function public.motion_immutable();

------------------------------------------------------------------------------
-- Visibility: consulted members see the motion; live choices stay hidden until the chair closes
------------------------------------------------------------------------------

-- Copied from 20261103150000_motions.sql (newest definition; untouched since), plus: a consulted
-- member sees a non-draft motion they are consulted on.
create or replace function public.can_see_motion(p_motion uuid)
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
        or (m.state <> 'draft' and exists (
          select 1 from public.motion_consulted mc where mc.motion_id = m.id and mc.profile_id = me.id
        ))
      )
  );
$$;


-- Standard motions are open ballot at all times; a live motion reveals its choices when closed.
create function public.motion_votes_revealed(p_motion uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.motions m
    where m.id = p_motion and (m.mode = 'standard' or m.live_closed_at is not null)
  )
$$;

revoke all on function public.motion_votes_revealed(uuid) from public, anon;
grant execute on function public.motion_votes_revealed(uuid) to authenticated;

drop policy motion_votes_select on public.motion_votes;
create policy motion_votes_select on public.motion_votes
  for select to authenticated
  using (public.can_see_motion(motion_id) and (voter_id = auth.uid() or public.motion_votes_revealed(motion_id)));

drop policy motion_log_select on public.motion_log;
create policy motion_log_select on public.motion_log
  for select to authenticated
  using (
    public.can_see_motion(motion_id)
    and (
      public.motion_votes_revealed(motion_id)
      or action not in ('vote', 'vote_changed', 'chair_vote', 'advisory_vote')
      or actor_id = auth.uid()
    )
  );

revoke all on public.motion_consulted, public.motion_advisory_votes from anon, authenticated;
grant select on public.motion_consulted, public.motion_advisory_votes to authenticated;
alter table public.motion_consulted enable row level security;
alter table public.motion_advisory_votes enable row level security;

create policy motion_consulted_select on public.motion_consulted
  for select to authenticated using (public.can_see_motion(motion_id));
create policy motion_advisory_votes_select on public.motion_advisory_votes
  for select to authenticated
  using (public.can_see_motion(motion_id) and (profile_id = auth.uid() or public.motion_votes_revealed(motion_id)));
-- No insert/update/delete policy: only the RPCs below write these.

------------------------------------------------------------------------------
-- Engine changes: a live motion is closed by the chair only
------------------------------------------------------------------------------

-- Copied from 20261103150000_motions.sql (newest definition; untouched since), plus the live skip.
create or replace function public.motion_evaluate(p_motion uuid, p_now timestamptz default now())
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

  -- A live meeting vote is closed by the chair only (close_live_vote).
  if m.mode = 'live' then
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


-- Copied from 20261103150000_motions.sql (newest definition; untouched since), plus: a vote the
-- chair recorded for a voter cannot be changed by a later self-cast.
create or replace function public.cast_vote(p_motion uuid, p_option text)
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

  if exists (
    select 1 from public.motion_votes v
    where v.motion_id = p_motion and v.round = m.round and v.voter_id = auth.uid() and v.recorded_by is not null
  ) then
    raise exception 'recorded_by_chair' using errcode = 'P0001';
  end if;

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


-- Copied from 20261103160000_meeting_agendas.sql (newest definition; untouched since), plus: the
-- wording and kind of a vote item are frozen once a vote has been opened for it.
create or replace function public.agenda_items_prepare()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  published boolean;
begin
  new.title := btrim(new.title);
  new.updated_at := now();
  select (a.status = 'published') into published from public.agendas a where a.id = new.agenda_id;
  if tg_op = 'INSERT' then
    new.edited_since_publish := coalesce(published, false);
    new.updated_in_publish := null;
  else
    new.agenda_id := old.agenda_id;
    if (old.kind, old.vote_wording) is distinct from (new.kind, new.vote_wording)
       and exists (
         select 1 from public.motions m
         where m.parent_type = 'agenda_item' and m.parent_id = old.id and m.status <> 'withdrawn'
       ) then
      raise exception 'wording_frozen' using errcode = 'P0001';
    end if;
    if (new.title, new.planned_minutes, new.kind, new.presenter_id, new.visibility, new.notes_md, new.vote_wording)
       is distinct from
       (old.title, old.planned_minutes, old.kind, old.presenter_id, old.visibility, old.notes_md, old.vote_wording) then
      new.edited_since_publish := coalesce(published, false) or old.edited_since_publish;
    end if;
  end if;
  return new;
end;
$$;


------------------------------------------------------------------------------
-- Chair: open, record for a voter, close
------------------------------------------------------------------------------

create function public.open_live_vote(
  p_item uuid,
  p_consult_tier_ids uuid[] default null,
  p_parties uuid[] default '{}'
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  it public.agenda_items;
  a public.agendas;
  mid uuid;
  ttl text;
  consulted uuid[];
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into it from public.agenda_items where id = p_item for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  select * into a from public.agendas where id = it.agenda_id;
  if it.kind <> 'vote' then
    raise exception 'not_a_vote_item' using errcode = 'P0001';
  end if;
  if a.status <> 'published' then
    raise exception 'agenda_not_published' using errcode = 'P0001';
  end if;
  if it.vote_wording is null or btrim(it.vote_wording) = '' then
    raise exception 'no_wording' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.motions m
    where m.parent_type = 'agenda_item' and m.parent_id = p_item and m.status <> 'withdrawn'
  ) then
    raise exception 'already_opened' using errcode = 'P0001';
  end if;

  ttl := left(btrim(it.title), 120);
  if length(ttl) < 3 then ttl := ttl || ' vote'; end if;
  -- Created as a draft so the engine does not evaluate it before it is marked live.
  mid := public.motion_create(auth.uid(), 'agenda_vote', ttl, btrim(it.vote_wording), 'agenda_item', p_item,
    '["Yes", "No", "Abstain"]'::jsonb, 'old_guard', 1, p_parties, 'agenda_item', p_item, true);
  update public.motions
    set mode = 'live', state = 'open', opened_at = now(),
        quorum_at_open = (select quorum from public.meeting_vote_settings where singleton)
  where id = mid;
  perform public.motion_log_add(mid, 1::smallint, 'opened', auth.uid(), null, null, 'live vote opened by the chair');
  perform public.motion_start_round(mid, auth.uid());
  update public.motions set deadline = null where id = mid;

  insert into public.motion_consulted (motion_id, profile_id)
  select mid, p.id
  from public.profiles p
  join public.tiers t on t.id = p.tier_id
  where p.status = 'approved'
    and not exists (select 1 from public.motion_voters v where v.motion_id = mid and v.round = 1 and v.profile_id = p.id)
    and not exists (select 1 from public.motion_parties mp where mp.motion_id = mid and mp.profile_id = p.id)
    and (
      (p_consult_tier_ids is null
        and not t.role_based
        and exists (select 1 from public.tier_capabilities tc where tc.tier_id = t.id and tc.capability_key = 'read_event_details'))
      or (p_consult_tier_ids is not null and t.id = any (p_consult_tier_ids))
    );
  select coalesce(array_agg(c.profile_id), '{}') into consulted from public.motion_consulted c where c.motion_id = mid;
  perform public.motion_notify(consulted, 'Poll open: ' || ttl, 'Your advisory vote is requested. It does not count toward the result.', mid);
  return mid;
end;
$$;

revoke all on function public.open_live_vote(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.open_live_vote(uuid, uuid[], uuid[]) to authenticated;

create function public.record_vote_for(p_motion uuid, p_voter uuid, p_option text, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m public.motions;
  who text;
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into m from public.motions where id = p_motion for update;
  if not found or m.mode <> 'live' or m.state <> 'open' or m.status <> 'open' or m.live_closed_at is not null then
    raise exception 'motion_closed' using errcode = 'P0001';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(m.options) o where o = p_option) then
    raise exception 'bad_option' using errcode = 'P0001';
  end if;
  if p_note is null or length(btrim(p_note)) not between 3 and 300 then
    raise exception 'bad_reason' using errcode = 'P0001';
  end if;
  if p_voter = auth.uid() then
    raise exception 'own_vote' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.motion_voters v where v.motion_id = p_motion and v.round = m.round and v.profile_id = p_voter
  ) then
    raise exception 'not_eligible' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.motion_votes v where v.motion_id = p_motion and v.round = m.round and v.voter_id = p_voter
  ) then
    raise exception 'already_voted' using errcode = 'P0001';
  end if;

  select callsign into who from public.profiles where id = p_voter;
  insert into public.motion_votes (motion_id, round, voter_id, voter_callsign, option, recorded_by, record_note)
  values (p_motion, m.round, p_voter, who, p_option, auth.uid(), btrim(p_note));
  perform public.motion_log_add(p_motion, m.round, 'chair_vote', auth.uid(), null, p_option,
    left('recorded by chair for ' || coalesce(who, 'a voter') || ': ' || btrim(p_note), 600));
end;
$$;

revoke all on function public.record_vote_for(uuid, uuid, text, text) from public, anon;
grant execute on function public.record_vote_for(uuid, uuid, text, text) to authenticated;

create function public.cast_advisory_vote(p_motion uuid, p_option text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m public.motions;
  prior text;
begin
  select * into m from public.motions where id = p_motion for update;
  if not found or not public.can_see_motion(p_motion) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if m.mode <> 'live' or m.state <> 'open' or m.status <> 'open' or m.live_closed_at is not null then
    raise exception 'motion_closed' using errcode = 'P0001';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(m.options) o where o = p_option) then
    raise exception 'bad_option' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.motion_consulted c where c.motion_id = p_motion and c.profile_id = auth.uid()) then
    raise exception 'not_eligible' using errcode = '42501';
  end if;
  select option into prior from public.motion_advisory_votes where motion_id = p_motion and profile_id = auth.uid();
  if prior is not distinct from p_option then
    return;
  end if;
  insert into public.motion_advisory_votes (motion_id, profile_id, callsign, option)
  values (p_motion, auth.uid(), (select callsign from public.profiles where id = auth.uid()), p_option)
  on conflict (motion_id, profile_id) do update set option = excluded.option, updated_at = now();
  perform public.motion_log_add(p_motion, m.round, 'advisory_vote', auth.uid(), prior, p_option, 'advisory poll');
end;
$$;

revoke all on function public.cast_advisory_vote(uuid, text) from public, anon;
grant execute on function public.cast_advisory_vote(uuid, text) to authenticated;

create function public.close_live_vote(p_motion uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  m public.motions;
  n integer;
  cast_n integer;
  yes_n integer;
  no_n integer;
  abs_n integer;
  res text;
  audience uuid[];
begin
  if not public.has_capability('write_events') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into m from public.motions where id = p_motion for update;
  if not found or m.mode <> 'live' then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if m.state <> 'open' or m.status <> 'open' or m.live_closed_at is not null then
    raise exception 'motion_closed' using errcode = 'P0001';
  end if;

  select count(*) into n from public.motion_voters where motion_id = p_motion and round = m.round;
  select count(*),
         count(*) filter (where option = 'Yes'),
         count(*) filter (where option = 'No'),
         count(*) filter (where option = 'Abstain')
    into cast_n, yes_n, no_n, abs_n
  from public.motion_votes where motion_id = p_motion and round = m.round;

  if m.quorum_at_open is not null and cast_n < m.quorum_at_open then
    res := 'no_quorum';
  elsif n < 3 then
    res := 'tie';
  elsif yes_n * 2 > n then
    res := 'passed';
  elsif no_n * 2 > n then
    res := 'failed';
  else
    res := 'tie';
  end if;

  update public.motions
    set live_closed_at = now(), live_result = res, deadline = null
  where id = p_motion;
  perform public.motion_log_add(p_motion, m.round, 'live_closed', auth.uid(), null, null,
    res || ': yes ' || yes_n || ', no ' || no_n || ', abstain ' || abs_n || ' of ' || n || ' eligible, ' || cast_n || ' cast');

  if res in ('passed', 'failed', 'no_quorum') then
    update public.motions
      set state = 'closed', status = 'decided', decided_at = now(),
          outcome_option = case res when 'passed' then 'Yes' when 'failed' then 'No' else null end
    where id = p_motion;
    select coalesce(array_agg(s.x), '{}') into audience from (
      select a.profile_id as x from public.motion_audience(p_motion) a
      union select c.profile_id from public.motion_consulted c where c.motion_id = p_motion
    ) s;
    perform public.motion_notify(audience, 'Vote closed: ' || m.title,
      case res when 'passed' then 'Passed.' when 'failed' then 'Failed.' else 'No quorum: the vote has no result.' end, p_motion);
  else
    -- A tie (or fewer than 3 eligible voters) goes to the escalation ladder: the body is already
    -- the Old Guard, so it waits for an Admin to record the outcome.
    perform public.motion_escalate(p_motion, case when n < 3 then 'fewer than 3 eligible voters' else 'tie' end);
  end if;
  return res;
end;
$$;

revoke all on function public.close_live_vote(uuid) from public, anon;
grant execute on function public.close_live_vote(uuid) to authenticated;

-- What a viewer may know about a live vote while it is open: counts, and their own choices only.
create function public.live_vote_progress(p_motion uuid)
returns table (
  eligible integer, voted integer, consulted integer, advisory_voted integer, quorum integer,
  is_voter boolean, is_consulted boolean, my_vote text, my_advisory text, closed boolean
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  m public.motions;
begin
  select * into m from public.motions where id = p_motion;
  if not found or not public.can_see_motion(p_motion) then
    return;
  end if;
  return query
    select
      (select count(*)::integer from public.motion_voters v where v.motion_id = p_motion and v.round = m.round),
      (select count(*)::integer from public.motion_votes v where v.motion_id = p_motion and v.round = m.round),
      (select count(*)::integer from public.motion_consulted c where c.motion_id = p_motion),
      (select count(*)::integer from public.motion_advisory_votes x where x.motion_id = p_motion),
      m.quorum_at_open,
      exists (select 1 from public.motion_voters v where v.motion_id = p_motion and v.round = m.round and v.profile_id = auth.uid()),
      exists (select 1 from public.motion_consulted c where c.motion_id = p_motion and c.profile_id = auth.uid()),
      (select v.option from public.motion_votes v where v.motion_id = p_motion and v.round = m.round and v.voter_id = auth.uid()),
      (select x.option from public.motion_advisory_votes x where x.motion_id = p_motion and x.profile_id = auth.uid()),
      m.live_closed_at is not null;
end;
$$;

revoke all on function public.live_vote_progress(uuid) from public, anon;
grant execute on function public.live_vote_progress(uuid) to authenticated;

------------------------------------------------------------------------------
-- Minutes from the agenda: closed live votes
------------------------------------------------------------------------------

create or replace function public.create_minutes_from_agenda(
  p_agenda uuid,
  p_include_presenter_notes boolean default false,
  p_include_command_items boolean default false
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  a public.agendas;
  ev public.events;
  r record;
  n integer := 0;
  md text := '';
  attendees text;
  new_id uuid;
  lm public.motions;
  votes_txt text;
  adv_txt text;
begin
  if not (public.has_capability('write_minutes') and public.agenda_manager()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into a from public.agendas where id = p_agenda;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  select * into ev from public.events where id = a.event_id;

  for r in
    select i.*, nt.presenter_notes_md
    from public.agenda_items i
    left join public.agenda_item_notes nt on nt.item_id = i.id
    where i.agenda_id = p_agenda
      and (i.visibility = 'members' or p_include_command_items)
    order by i.position, i.created_at
  loop
    n := n + 1;
    md := md || '## ' || n || '. ' || r.title || E'\n\n';
    md := md || '_' || case r.kind when 'vote' then 'Vote' when 'inform' then 'For information' else 'Discussion' end
             || ', ' || r.planned_minutes || ' min planned_' || E'\n\n';
    if r.kind = 'vote' and r.vote_wording is not null and btrim(r.vote_wording) <> '' then
      md := md || '**Motion:** ' || r.vote_wording || E'\n\n';
    end if;
    if r.kind = 'vote' then
      select m.* into lm from public.motions m
      where m.parent_type = 'agenda_item' and m.parent_id = r.id and m.mode = 'live' and m.live_closed_at is not null
      order by m.created_at desc limit 1;
      if found then
        md := md || '**Result:** ' || case lm.live_result
          when 'passed' then 'Passed' when 'failed' then 'Failed' when 'tie' then 'Tie'
          else 'No quorum' end
          || case when lm.decided_final_by is not null then ' (final outcome recorded by an Admin: ' || coalesce(lm.outcome_option, '-') || ')' else '' end
          || E'\n\n';
        select string_agg(
                 v.voter_callsign || ': ' || v.option
                 || case when v.recorded_by is not null
                         then ' (recorded by chair for ' || v.voter_callsign || ': ' || coalesce(v.record_note, '') || ')'
                         else '' end,
                 E'\n' order by v.voter_callsign)
          into votes_txt
        from public.motion_votes v where v.motion_id = lm.id and v.round = lm.round;
        md := md || '**Votes by name:**' || E'\n\n' || coalesce(votes_txt, '_(none cast)_') || E'\n\n';
        select 'Yes ' || count(*) filter (where option = 'Yes')
               || ', No ' || count(*) filter (where option = 'No')
               || ', Abstain ' || count(*) filter (where option = 'Abstain')
          into adv_txt
        from public.motion_advisory_votes x where x.motion_id = lm.id;
        md := md || '**Advisory poll (consulted members, not counted):** ' || coalesce(adv_txt, 'none') || E'\n\n';
      end if;
    end if;
    if p_include_presenter_notes and r.presenter_notes_md is not null then
      md := md || '**Presenter notes:** ' || r.presenter_notes_md || E'\n\n';
    end if;
    md := md || '**Outcome:** ' || coalesce(nullif(btrim(r.outcome_md), ''), '_(record the outcome)_') || E'\n\n';
  end loop;

  select string_agg('- ' || p.callsign, E'\n' order by p.callsign) into attendees
  from public.event_rsvps rs join public.profiles p on p.id = rs.profile_id
  where rs.event_id = a.event_id and rs.response = 'in';

  md := md || '## Attendees' || E'\n\n'
     || coalesce(attendees || E'\n\n_(listed from RSVPs; edit to match who attended)_', '_(list who attended)_')
     || E'\n';

  insert into public.minutes (title, meeting_date, body_md, status)
  values (left('Minutes: ' || ev.title, 160), ((ev.starts_at at time zone 'UTC') - interval '7 hours')::date, md, 'draft')
  returning id into new_id;
  return new_id;
end;
$$;

