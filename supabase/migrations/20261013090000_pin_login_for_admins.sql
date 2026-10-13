-- Name + PIN sign-in for admins too (Fahru, 2026-10-13):
--   "Saya taknak kompleks seperti guna email. Nak mudah. Convert terus dari
--    panel."
-- An admin switches anyone between Tukang Gunting and Admin from the staff
-- list (a plain staff.role update, already allowed for admins and guarded by
-- the keep-one-active-admin trigger). The person keeps signing in with the
-- same name + PIN whichever role they hold, so a PIN must work for both
-- roles. E-mail + password sign-in is unchanged for accounts that have one.
--
-- Only the role filter changes in the three functions below; everything else
-- (bcrypt hashes, 5-wrong-PIN 15-minute lock, weak-PIN rejection, grants) is
-- as in 20261012170000_barber_pin_login_and_admin_recovery.sql.

create or replace function public.admin_set_barber_pin(p_staff_id uuid, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
    if not public.is_admin() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;
    if p_pin is null or p_pin !~ '^[0-9]{6}$' then
        raise exception 'PIN mesti 6 digit nombor.' using errcode = '22023';
    end if;
    if p_pin ~ '^(.)\1{5}$' or p_pin in ('123456', '654321', '012345', '543210') then
        raise exception 'PIN terlalu mudah diteka. Pilih PIN lain.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.staff where id = p_staff_id and role in ('barber', 'admin')) then
        raise exception 'Kakitangan tidak ditemui.' using errcode = 'P0002';
    end if;

    insert into public.staff_pins (staff_id, pin_hash, failed_attempts, locked_until, updated_at)
    values (p_staff_id, crypt(p_pin, gen_salt('bf', 10)), 0, null, now())
    on conflict (staff_id) do update
        set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
end $$;

revoke all on function public.admin_set_barber_pin(uuid, text) from public, anon;
grant execute on function public.admin_set_barber_pin(uuid, text) to authenticated;

-- Sign-in screen: every active staff member who has a PIN (names only).
create or replace function public.list_login_barbers()
returns table (id uuid, display_name text)
language sql stable security definer set search_path = public as $$
    select s.id, s.display_name
      from public.staff s
      join public.staff_pins p on p.staff_id = s.id
     where s.active and s.role in ('barber', 'admin')
     order by s.display_name;
$$;

revoke all on function public.list_login_barbers() from public;
grant execute on function public.list_login_barbers() to anon, authenticated;

create or replace function public._verify_barber_pin(p_staff_id uuid, p_pin text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
    v_row public.staff_pins;
begin
    select p.* into v_row
      from public.staff_pins p
      join public.staff s on s.id = p.staff_id
     where p.staff_id = p_staff_id and s.active and s.role in ('barber', 'admin')
     for update of p;
    if not found then
        return 'unknown';
    end if;

    if v_row.locked_until is not null and v_row.locked_until > now() then
        return 'locked';
    end if;

    if p_pin is not null and v_row.pin_hash = crypt(p_pin, v_row.pin_hash) then
        update public.staff_pins set failed_attempts = 0, locked_until = null where staff_id = p_staff_id;
        return 'ok';
    end if;

    update public.staff_pins
       set failed_attempts = case when v_row.failed_attempts + 1 >= 5 then 0 else v_row.failed_attempts + 1 end,
           locked_until    = case when v_row.failed_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
     where staff_id = p_staff_id;
    return case when v_row.failed_attempts + 1 >= 5 then 'locked' else 'bad' end;
end $$;

revoke all on function public._verify_barber_pin(uuid, text) from public, anon, authenticated;
grant execute on function public._verify_barber_pin(uuid, text) to service_role;
