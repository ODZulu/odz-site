-- One-off bootstrap: promote the first admin. Run manually in the Supabase SQL editor.
--
-- 1. Sign up through the app (or create the user in the Supabase dashboard) so the
--    account and its pending profile exist.
-- 2. Paste this file into the SQL editor and replace the placeholder below with the real
--    email. Do NOT commit the edited file: the repo is public.
-- 3. Run it. The guard trigger trusts SQL-editor callers, so is_admin can be set here.

do $$
declare
  target_email text := 'REPLACE_WITH_ADMIN_EMAIL';
  target_id uuid;
begin
  if target_email = 'REPLACE_WITH_ADMIN_EMAIL' then
    raise exception 'Replace the placeholder email before running';
  end if;

  select id into target_id from auth.users where email = target_email;
  if target_id is null then
    raise exception 'No auth user with that email; sign up first';
  end if;

  update public.profiles
     set is_admin = true, status = 'approved'
   where id = target_id;
end;
$$;
