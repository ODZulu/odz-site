-- MVA-248: change password in the app. The change itself is Supabase Auth (the client re-checks the
-- current password with signInWithPassword, then updateUser); this migration only adds the audit
-- trail, because the browser can never write profile_audit directly.
--
--   * log_password_change(): SECURITY DEFINER, search_path pinned. The caller must be an approved or
--     retired account (pending, suspended and removed accounts cannot reach the screen and are
--     refused here too). It writes one profile_audit row for the caller: who and when, with fixed
--     placeholder values ('password' -> 'changed'). No password, partial password or hash is ever
--     passed to or stored by this function: it takes no arguments.
--   * The row is self-reported (the browser calls it after Auth accepted the change). Supabase
--     Auth stays the source of truth for the password; the audit row records that the member did it.
--   * Dashboard setting (Auth > Providers > Email): leave "Secure password change" OFF. With it on,
--     Supabase demands a recent sign-in or an email confirmation for a password change, and this
--     feature must work with no email (MVA-200, SMTP, is separate). The client re-authenticates with
--     the current password itself, which is the check that setting would otherwise provide.
--
-- Additive: one audit event name and one new function. No existing row is rewritten.

alter table public.profile_audit drop constraint profile_audit_event_check;
alter table public.profile_audit
  add constraint profile_audit_event_check
  check (event in ('status', 'tier', 'admin', 'private', 'profile', 'retired', 'unretired', 'member_reinstated', 'password_changed'));

create function public.log_password_change()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null
     or not exists (select 1 from public.profiles p where p.id = auth.uid() and p.status in ('approved', 'retired')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.profile_audit (profile_id, actor_id, event, old_value, new_value)
  values (auth.uid(), auth.uid(), 'password_changed', 'password', 'changed');
end;
$$;

revoke all on function public.log_password_change() from public, anon;
grant execute on function public.log_password_change() to authenticated;
