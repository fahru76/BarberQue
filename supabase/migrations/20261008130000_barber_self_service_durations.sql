-- Barber sets his own service (haircut) times.
--
-- Fahru's request (2026-10-08): each barber can set his own average time per
-- service on his page. This reuses the EXISTING per-barber override,
-- staff.service_durations ({ service_id: minutes }, 20260908130000), which
-- call_next_customer() already applies when the barber calls a customer --
-- no change to dispatch. Until now only admin could write it.
--
-- 1. set_my_services() gains an optional p_durations argument (NULL = leave
--    durations untouched, so older callers keep working). The 2-arg version
--    is dropped and replaced -- an overload would make PostgREST's named-arg
--    resolution ambiguous.
-- 2. The "last changed by" stamp (20261008120000) now also covers duration
--    changes, since a barber can make them himself.

drop function if exists public.set_my_services(text[], text[]);

create or replace function public.set_my_services(
    p_capability text[],
    p_specialty  text[],
    p_durations  jsonb default null
)
returns table (capability_service_ids text[], specialty_service_ids text[], service_durations jsonb)
language plpgsql security definer set search_path = public as $$
declare
    v_me        uuid := auth.uid();
    v_cap       text[];
    v_spec      text[];
    v_durations jsonb;
    v_bad       text;
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

    -- Durations: NULL = unchanged; {} = clear (use shop defaults). Each key
    -- must be an active service this barber offers (any active service when
    -- he offers all); each value a whole number of minutes 1-480, the same
    -- range as queues.duration_minutes and the admin card.
    if p_durations is not null then
        if jsonb_typeof(p_durations) <> 'object' then
            raise exception 'Format masa servis tidak sah' using errcode = '22023';
        end if;

        select key into v_bad
          from jsonb_each(p_durations)
         where not exists (select 1 from public.services s where s.id = key and s.active)
            or (v_cap is not null and not (key = any (v_cap)))
         limit 1;
        if v_bad is not null then
            raise exception 'Masa servis untuk "%" tidak dibenarkan (servis tidak aktif atau bukan servis anda)', v_bad using errcode = '22023';
        end if;

        select key into v_bad
          from jsonb_each(p_durations)
         where jsonb_typeof(value) <> 'number'
            or (value #>> '{}') !~ '^[1-9][0-9]{0,2}$'
            or (value #>> '{}')::integer > 480
         limit 1;
        if v_bad is not null then
            raise exception 'Masa servis mesti nombor bulat 1 hingga 480 minit' using errcode = '22023';
        end if;

        v_durations := nullif(p_durations, '{}'::jsonb);
    end if;

    return query
        update public.staff st
           set capability_service_ids = v_cap,
               specialty_service_ids  = v_spec,
               service_durations      = case when p_durations is null then st.service_durations else v_durations end
         where st.id = v_me
        returning st.capability_service_ids, st.specialty_service_ids, st.service_durations;
end $$;

revoke all on function public.set_my_services(text[], text[], jsonb) from public, anon;
grant execute on function public.set_my_services(text[], text[], jsonb) to authenticated;

-- "Last changed by" now includes durations.
create or replace function public._staff_stamp_services_change()
returns trigger language plpgsql set search_path = public as $$
begin
    if new.capability_service_ids is distinct from old.capability_service_ids
       or new.specialty_service_ids is distinct from old.specialty_service_ids
       or new.service_durations is distinct from old.service_durations then
        new.services_updated_at := now();
        new.services_updated_by := auth.uid();
    else
        new.services_updated_at := old.services_updated_at;
        new.services_updated_by := old.services_updated_by;
    end if;
    return new;
end $$;
