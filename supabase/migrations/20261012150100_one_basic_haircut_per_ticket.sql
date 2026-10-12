-- One basic haircut per ticket/booking (server-side backstop).
--
-- Fahru's request (2026-10-12): an adult basic cut and a kids basic cut must
-- never be selected together (and vice versa). The service picker in
-- index.html already locks the second one; this trigger enforces the same
-- rule on the server so a modified browser or a direct API call cannot get
-- around it.
--
-- The rule is keyed on services.category = 'asas' and type = 'gunting' --
-- not on target -- because the live adult cut ("Gunting Biasa") is set to
-- target 'semua', which the existing adult/kids target rule never blocks.
--
-- Only checked when service_ids is written (insert, or an update that
-- changes it), so existing rows are untouched. A null service_ids (legacy
-- rows/clients) is let through, same as the other service_ids checks.

create or replace function public._enforce_one_basic_haircut()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    v_basic_cuts integer;
begin
    if new.service_ids is null or array_length(new.service_ids, 1) is null then
        return new;
    end if;

    select count(*) into v_basic_cuts
      from public.services s
     where s.id = any(new.service_ids)
       and s.category = 'asas'
       and s.type = 'gunting';

    if v_basic_cuts > 1 then
        raise exception 'Pilih satu gunting asas sahaja: gunting dewasa atau gunting kanak-kanak, bukan kedua-duanya.'
            using errcode = '22023';
    end if;

    return new;
end $$;

revoke all on function public._enforce_one_basic_haircut() from public, anon, authenticated;

drop trigger if exists queues_one_basic_haircut on public.queues;
create trigger queues_one_basic_haircut
    before insert or update of service_ids on public.queues
    for each row execute function public._enforce_one_basic_haircut();

drop trigger if exists appointments_one_basic_haircut on public.appointments;
create trigger appointments_one_basic_haircut
    before insert or update of service_ids on public.appointments
    for each row execute function public._enforce_one_basic_haircut();
