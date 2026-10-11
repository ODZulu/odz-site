-- MVA-199 follow-up (Dax, 2026-10-11): drop the hard-coded initial-admin exception from signup.
-- The initial admin was created by hand in the Supabase dashboard instead, so no email address
-- needs to live in this public repo. Signup is invite-only for every address again.
--
-- Consequence: a user added from the dashboard ("Add user") also needs a valid invite code in its
-- metadata, otherwise the signup trigger rejects it. To add an admin by hand later: make an invite
-- (supabase/seed/first_invite.sql), sign up at /join, then run supabase/seed/promote_admin.sql.

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_tier uuid;
begin
  v_tier := public.redeem_invite(new.raw_user_meta_data ->> 'invite_code', new.id);
  insert into public.profiles (id, tier_id) values (new.id, v_tier);
  return new;
end;
$$;
