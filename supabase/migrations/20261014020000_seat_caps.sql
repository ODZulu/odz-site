-- MVA-234: tier seat caps (Dax ruling, 2026-10-13). Old Guard is 12 with Command counted inside
-- it; Command is 3. The database blocks exceeding either; the UI only reports it.
--
--   * Caps live in a one-row settings table (seat_caps). Only an Admin changes them, through
--     set_seat_caps(), logged in settings_audit (who, when, old, new). A change applies to future
--     moves only: nobody is demoted because a cap was lowered.
--   * Which tiers hold seats is data on the tier (tiers.seat_group), not a name check, so renaming
--     a tier never breaks the rule.
--   * Old Guard tally = accounts in the 'old_guard' or 'command' group (Command is part of Old
--     Guard). Command tally = the 'command' group. A seat is held by an approved or suspended
--     account. Pending accounts hold none, and a removed (MVA-209) or deleted account frees its
--     seat at once. Demotion frees it at once.
--   * profiles_seat_cap() is a before insert/update trigger on profiles, so it covers roster
--     edits, approvals, the SQL editor and any bulk path. It takes one advisory lock, so two
--     simultaneous promotions cannot both pass the cap.
--   * Moving Command -> Old Guard (the release rule) and Old Guard -> Command do not change the
--     Old Guard tally. Only a transition INTO a seat is checked.
--   * Invites cannot carry Old Guard or Command: those tiers are not invitable (unchanged;
--     tested here).
--
-- profiles_guard() runs first (trigger names fire in alphabetical order: profiles_guard <
-- profiles_joined < profiles_seat_cap), so the Command release rule has already rewritten the
-- target tier when this trigger looks at it.
--
-- Additive, plus one config update on the two seat tiers (see below). No function from an earlier
-- migration is redefined.

------------------------------------------------------------------------------
-- Which tiers hold seats
------------------------------------------------------------------------------

alter table public.tiers
  add column seat_group text check (seat_group in ('old_guard', 'command'));

create unique index tiers_seat_group_key on public.tiers (seat_group) where seat_group is not null;

-- The only statement that touches existing rows: two tier config rows, no member data.
update public.tiers set seat_group = 'old_guard' where name = 'Old Guard';
update public.tiers set seat_group = 'command' where name = 'Command';

------------------------------------------------------------------------------
-- Caps (one row)
------------------------------------------------------------------------------

create table public.seat_caps (
  singleton boolean primary key default true check (singleton),
  old_guard_max integer not null check (old_guard_max between 1 and 99),
  command_max integer not null check (command_max between 1 and 99),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint seat_caps_command_within_old_guard check (command_max <= old_guard_max)
);

insert into public.seat_caps (old_guard_max, command_max) values (12, 3);

revoke all on public.seat_caps from anon, authenticated;
grant select on public.seat_caps to authenticated;

alter table public.seat_caps enable row level security;

-- The numbers are not sensitive (the tier breakdown already shows counts); any approved account may read them.
create policy seat_caps_select on public.seat_caps
  for select to authenticated using (public.current_user_is_approved());
-- No insert/update/delete policy: clients change caps only through set_seat_caps().

------------------------------------------------------------------------------
-- Tally
------------------------------------------------------------------------------

-- p_group 'old_guard' counts Old Guard and Command; 'command' counts Command only.
create function public.seat_tally(p_group text)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer
  from public.profiles p
  join public.tiers t on t.id = p.tier_id
  where p.status in ('approved', 'suspended')
    and (t.seat_group = 'command' or (p_group = 'old_guard' and t.seat_group = 'old_guard'));
$$;

revoke all on function public.seat_tally(text) from public, anon, authenticated;

------------------------------------------------------------------------------
-- Enforcement
------------------------------------------------------------------------------

create function public.profiles_seat_cap()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  caps public.seat_caps;
  new_g text;
  old_g text;
  old_holds boolean := false;
  n integer;
begin
  select t.seat_group into new_g from public.tiers t where t.id = new.tier_id;
  if new_g is null or new.status not in ('approved', 'suspended') then
    return new;  -- not taking a seat
  end if;

  if tg_op = 'UPDATE' then
    select t.seat_group into old_g from public.tiers t where t.id = old.tier_id;
    old_holds := old_g is not null and old.status in ('approved', 'suspended');
  end if;

  -- One lock for every seat change, so concurrent promotions are checked one at a time. Each
  -- later statement sees the earlier transaction's committed rows (read committed).
  perform pg_advisory_xact_lock(hashtext('odz.seat_caps'));
  select * into caps from public.seat_caps;

  if not old_holds then
    n := public.seat_tally('old_guard');
    if n >= caps.old_guard_max then
      raise exception 'Old Guard is full: %/%', n, caps.old_guard_max using errcode = 'P0001';
    end if;
  end if;

  if new_g = 'command' and not (old_holds and old_g = 'command') then
    n := public.seat_tally('command');
    if n >= caps.command_max then
      raise exception 'Command is full: %/%', n, caps.command_max using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.profiles_seat_cap() from public, anon, authenticated;

create trigger profiles_seat_cap
  before insert or update on public.profiles
  for each row execute function public.profiles_seat_cap();

------------------------------------------------------------------------------
-- Admin changes the caps (logged; future moves only)
------------------------------------------------------------------------------

create function public.set_seat_caps(p_old_guard_max integer, p_command_max integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  old_caps public.seat_caps;
begin
  if not public.current_user_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_old_guard_max is null or p_command_max is null
     or p_old_guard_max not between 1 and 99 or p_command_max not between 1 and 99
     or p_command_max > p_old_guard_max then
    raise exception 'invalid_caps' using errcode = 'P0001';
  end if;

  select * into old_caps from public.seat_caps for update;
  if old_caps.old_guard_max = p_old_guard_max and old_caps.command_max = p_command_max then
    return;
  end if;

  update public.seat_caps
     set old_guard_max = p_old_guard_max, command_max = p_command_max, updated_at = now(), updated_by = auth.uid();

  insert into public.settings_audit (actor_id, event, target, detail)
  values (
    auth.uid(), 'seat_caps_changed', 'seat caps',
    'old_guard ' || old_caps.old_guard_max || ' -> ' || p_old_guard_max
      || ', command ' || old_caps.command_max || ' -> ' || p_command_max
  );
end;
$$;

revoke all on function public.set_seat_caps(integer, integer) from public, anon;
grant execute on function public.set_seat_caps(integer, integer) to authenticated;

------------------------------------------------------------------------------
-- Counters for the roster page: seat holders, roster managers and Admin
------------------------------------------------------------------------------

create function public.seat_counts()
returns table (old_guard_count integer, old_guard_max integer, command_count integer, command_max integer)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (
    public.has_capability('edit_roster')
    or public.has_capability('approve_members')
    or exists (
      select 1 from public.profiles p join public.tiers t on t.id = p.tier_id
      where p.id = auth.uid() and p.status = 'approved' and t.seat_group is not null
    )
  ) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select public.seat_tally('old_guard'), c.old_guard_max, public.seat_tally('command'), c.command_max
    from public.seat_caps c;
end;
$$;

revoke all on function public.seat_counts() from public, anon;
grant execute on function public.seat_counts() to authenticated;

------------------------------------------------------------------------------
-- Deploy check: report, do not fix
------------------------------------------------------------------------------
-- If a tally is already over a cap, the migration still applies: nobody is moved, the counters
-- show over-cap and promotion stays blocked until the tally is under the cap. A row in
-- settings_audit records it (nothing is written when counts are within the caps).

do $$
declare
  og integer := public.seat_tally('old_guard');
  cm integer := public.seat_tally('command');
  caps public.seat_caps;
begin
  select * into caps from public.seat_caps;
  raise notice 'seat caps: Old Guard %/%, Command %/%', og, caps.old_guard_max, cm, caps.command_max;
  if og > caps.old_guard_max or cm > caps.command_max then
    insert into public.settings_audit (actor_id, event, target, detail)
    values (null, 'seat_caps_over', 'deploy check',
            'Old Guard ' || og || '/' || caps.old_guard_max || ', Command ' || cm || '/' || caps.command_max);
  end if;
end;
$$;
