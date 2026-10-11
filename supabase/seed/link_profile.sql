-- Backstage repair: make sure an existing auth user has a profile, and optionally promote it.
-- Run manually in the Supabase SQL editor. Do NOT commit the edited copy: the repo is public.
--
-- Normal signups get their profile from the signup trigger, so this is only for users that were
-- created some other way and have no profile row (check: Authentication > Users shows the user
-- but Table Editor > profiles has no row with the same id).
--
-- Set the email, then choose what the profile should be. For an admin, leave make_admin = true.

do $$
declare
  target_email text := 'REPLACE_WITH_USER_EMAIL';
  make_admin boolean := true;
  target_id uuid;
begin
  if target_email = 'REPLACE_WITH_USER_EMAIL' then
    raise exception 'Replace the placeholder email before running';
  end if;

  select id into target_id from auth.users where lower(email) = lower(target_email);
  if target_id is null then
    raise exception 'No auth user with that email';
  end if;

  -- Callsign stays empty unless the account goes through setup; an admin created here is
  -- marked set up so it lands on the app and not on the setup form.
  insert into public.profiles (id, status, is_admin, setup_complete, callsign, display_name)
  values (
    target_id,
    case when make_admin then 'approved' else 'pending' end,
    make_admin,
    make_admin,
    case when make_admin then 'ODZ Admin' end,
    case when make_admin then 'ODZ Admin' end
  )
  on conflict (id) do update set
    status = excluded.status,
    is_admin = excluded.is_admin,
    setup_complete = excluded.setup_complete
  where make_admin;
end;
$$;
