-- MVA-255: let an Admin read the Treasury member-access switch so the app can show and flip it.
-- Additive: one new read-only function. No table, policy, column or existing function changes.
-- treasury_settings keeps no grant and no policy (MVA-216); this is the only read path, Admin only.
-- Writing stays with set_treasury_member_access(boolean) (20261103180000_treasury_ledger.sql), unchanged.

create function public.treasury_member_access()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when public.current_user_is_admin()
              then (select member_access from public.treasury_settings where singleton)
              else null end;
$$;

revoke all on function public.treasury_member_access() from public, anon;
grant execute on function public.treasury_member_access() to authenticated;
