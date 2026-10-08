-- Barber self-service skills/services ("Kemahiran & Servis Saya").
--
-- Fahru's correction (2026-10-08): on their own page a barber may change not
-- only duty + break but also the services they can offer
-- (capability_service_ids) and their skills/specialty
-- (specialty_service_ids). Custom service durations stay admin-only.
--
-- enforce_staff_self_update_scope() (20260909133619) still blocks a barber
-- from writing these columns DIRECTLY on public.staff -- that trigger stays
-- exactly as is. This function is the one sanctioned self-service path, and
-- it validates what a raw table write never would:
--   * only the caller's own row (auth.uid()), only an active staff member;
--   * every id must be a real, ACTIVE service in public.services;
--   * specialty must be a subset of capability (same rule as the
--     staff_specialty_subset_of_capability constraint, checked first so the
--     barber gets a readable message);
--   * same storage convention as the admin card: an empty list is stored as
--     NULL, i.e. capability NULL = "can do every service", specialty NULL =
--     "no preference".
-- SECURITY DEFINER runs as the function owner, so the self-update trigger's
-- `current_user <> 'authenticated'` early-return lets this write through.

create or replace function public.set_my_services(p_capability text[], p_specialty text[])
returns table (capability_service_ids text[], specialty_service_ids text[])
language plpgsql security definer set search_path = public as $$
declare
    v_me   uuid := auth.uid();
    v_cap  text[];
    v_spec text[];
    v_bad  text;
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    if coalesce(cardinality(p_capability), 0) > 200 or coalesce(cardinality(p_specialty), 0) > 200 then
        raise exception 'Senarai servis terlalu panjang' using errcode = '22023';
    end if;

    select array_agg(distinct x order by x) into v_cap
      from unnest(coalesce(p_capability, '{}'::text[])) as x where nullif(btrim(x), '') is not null;
    select array_agg(distinct x order by x) into v_spec
      from unnest(coalesce(p_specialty, '{}'::text[])) as x where nullif(btrim(x), '') is not null;

    select x into v_bad
      from unnest(coalesce(v_cap, '{}'::text[]) || coalesce(v_spec, '{}'::text[])) as x
     where not exists (select 1 from public.services s where s.id = x and s.active)
     limit 1;
    if v_bad is not null then
        raise exception 'Servis "%" tidak wujud atau tidak aktif', v_bad using errcode = '22023';
    end if;

    if v_cap is not null and v_spec is not null and not (v_spec <@ v_cap) then
        raise exception 'Kemahiran utama mesti juga servis yang anda tawarkan' using errcode = '22023';
    end if;

    return query
        update public.staff st
           set capability_service_ids = v_cap,
               specialty_service_ids  = v_spec
         where st.id = v_me
        returning st.capability_service_ids, st.specialty_service_ids;
end $$;

revoke all on function public.set_my_services(text[], text[]) from public, anon;
grant execute on function public.set_my_services(text[], text[]) to authenticated;
