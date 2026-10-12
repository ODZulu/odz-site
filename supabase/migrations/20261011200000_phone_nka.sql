-- MVA-207: one phone format (xxx-xxx-xxxx) and NKA for no allergies, enforced in the database.
-- Errors stay fixed codes (invalid_phone, invalid_emergency_phone) and never echo the value.

------------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------------

-- Digits only, a leading US country code dropped from an 11-digit number, exactly 10 digits
-- required. Returns xxx-xxx-xxxx, or null when the input cannot be normalized.
create function public.normalize_phone(p_raw text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when length(d) = 10 then substr(d, 1, 3) || '-' || substr(d, 4, 3) || '-' || substr(d, 7, 4)
    else null
  end
  from (
    select case
      when length(regexp_replace(coalesce(p_raw, ''), '\D', '', 'g')) = 11
           and regexp_replace(coalesce(p_raw, ''), '\D', '', 'g') like '1%'
        then substr(regexp_replace(coalesce(p_raw, ''), '\D', '', 'g'), 2)
      else regexp_replace(coalesce(p_raw, ''), '\D', '', 'g')
    end as d
  ) s;
$$;

-- Trimmed; none / no / n/a / na / nil / nka in any case are stored as exactly NKA.
create function public.normalize_allergies(p_raw text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when lower(btrim(coalesce(p_raw, ''))) in ('none', 'no', 'n/a', 'na', 'nil', 'nka') then 'NKA'
    else btrim(coalesce(p_raw, ''))
  end;
$$;

revoke all on function public.normalize_phone(text) from public, anon, authenticated;
revoke all on function public.normalize_allergies(text) from public, anon, authenticated;

------------------------------------------------------------------------------
-- Existing rows, then the CHECK constraints
------------------------------------------------------------------------------

alter table public.member_private drop constraint if exists member_private_phone_check;
alter table public.member_private drop constraint if exists member_private_emergency_phone_check;

-- Optional phone: normalize what can be normalized, null the rest.
update public.member_private
set phone = public.normalize_phone(phone)
where phone is not null;

-- Required emergency phone: normalize, and fail loudly if any row cannot be (fix it by hand first).
update public.member_private
set emergency_phone = coalesce(public.normalize_phone(emergency_phone), emergency_phone);

do $$
begin
  if exists (select 1 from public.member_private where emergency_phone !~ '^[0-9]{3}-[0-9]{3}-[0-9]{4}$') then
    raise exception 'member_private has emergency phones that cannot be normalized; fix them, then re-run';
  end if;
end;
$$;

alter table public.member_private
  add constraint member_private_phone_format
    check (phone is null or phone ~ '^[0-9]{3}-[0-9]{3}-[0-9]{4}$'),
  add constraint member_private_emergency_phone_format
    check (emergency_phone ~ '^[0-9]{3}-[0-9]{3}-[0-9]{4}$');

------------------------------------------------------------------------------
-- Shared validation (used by update_own_private) and the two writers
------------------------------------------------------------------------------

create or replace function public.assert_private_valid(
  p_legal_name text, p_dob date, p_phone text, p_allergies text,
  p_emergency_name text, p_emergency_relationship text, p_emergency_phone text
)
returns void
language plpgsql stable set search_path = ''
as $$
begin
  if length(btrim(coalesce(p_legal_name, ''))) not between 1 and 100 then
    raise exception 'invalid_legal_name' using errcode = 'P0001';
  end if;
  if p_dob is null or p_dob < date '1900-01-01' or p_dob > current_date then
    raise exception 'invalid_dob' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_phone, '')), '') is not null and public.normalize_phone(p_phone) is null then
    raise exception 'invalid_phone' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_allergies, ''))) not between 1 and 500 then
    raise exception 'invalid_allergies' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_emergency_name, ''))) not between 1 and 100 then
    raise exception 'invalid_emergency_name' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_emergency_relationship, ''))) not between 1 and 50 then
    raise exception 'invalid_emergency_relationship' using errcode = 'P0001';
  end if;
  if public.normalize_phone(p_emergency_phone) is null then
    raise exception 'invalid_emergency_phone' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.update_own_private(
  p_legal_name text, p_dob date, p_phone text, p_allergies text,
  p_emergency_name text, p_emergency_relationship text, p_emergency_phone text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null or not exists (select 1 from public.profiles p where p.id = uid and p.status <> 'suspended' and p.setup_complete) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.assert_private_valid(p_legal_name, p_dob, p_phone, p_allergies,
                                      p_emergency_name, p_emergency_relationship, p_emergency_phone);
  update public.member_private set
    legal_name = btrim(p_legal_name),
    dob = p_dob,
    phone = public.normalize_phone(nullif(btrim(coalesce(p_phone, '')), '')),
    allergies = public.normalize_allergies(p_allergies),
    emergency_name = btrim(p_emergency_name),
    emergency_relationship = btrim(p_emergency_relationship),
    emergency_phone = public.normalize_phone(p_emergency_phone)
  where profile_id = uid;
  if not found then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.complete_setup(
  p_callsign text,
  p_legal_name text,
  p_dob date,
  p_phone text,
  p_allergies text,
  p_emergency_name text,
  p_emergency_relationship text,
  p_emergency_phone text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  prof public.profiles;
  v_callsign text := btrim(p_callsign);
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into prof from public.profiles where id = uid;
  if not found or prof.status = 'suspended' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if prof.setup_complete then
    raise exception 'setup_already_complete' using errcode = 'P0001';
  end if;

  if v_callsign is null or v_callsign !~ '^[A-Za-z0-9 _-]{2,24}$' then
    raise exception 'invalid_callsign' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles p where lower(p.callsign) = lower(v_callsign) and p.id <> uid) then
    raise exception 'callsign_taken' using errcode = 'P0001';
  end if;
  perform public.assert_private_valid(p_legal_name, p_dob, p_phone, p_allergies,
                                      p_emergency_name, p_emergency_relationship, p_emergency_phone);

  insert into public.member_private
    (profile_id, legal_name, dob, phone, allergies, emergency_name, emergency_relationship, emergency_phone)
  values
    (uid, btrim(p_legal_name), p_dob, public.normalize_phone(nullif(btrim(coalesce(p_phone, '')), '')),
     public.normalize_allergies(p_allergies), btrim(p_emergency_name),
     btrim(p_emergency_relationship), public.normalize_phone(p_emergency_phone))
  on conflict (profile_id) do update set
    legal_name = excluded.legal_name, dob = excluded.dob, phone = excluded.phone,
    allergies = excluded.allergies, emergency_name = excluded.emergency_name,
    emergency_relationship = excluded.emergency_relationship, emergency_phone = excluded.emergency_phone;

  update public.profiles set callsign = v_callsign, setup_complete = true where id = uid;
end;
$$;
