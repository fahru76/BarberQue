-- "Last changed by" for a barber's services/skills.
--
-- Fahru's request (2026-10-08): since barbers can now set their own
-- services/skills (set_my_services(), 20261008110000), admin should see on
-- each barber's card when the services were last changed and by whom --
-- the barber himself or an admin.
--
-- Stamped by a trigger, so BOTH write paths are covered without touching
-- either of them: set_my_services() (barber) and the admin card's direct
-- update via setStaffStatus(). The stamp is unforgeable: if the
-- services/skills columns did not change, the trigger copies the OLD stamp
-- back, so nobody (incl. a barber's allowed display-name self-update) can
-- write these two columns directly.

alter table public.staff
    add column services_updated_at timestamptz,
    add column services_updated_by uuid references public.staff (id) on delete set null;

comment on column public.staff.services_updated_at is
    'When capability_service_ids/specialty_service_ids last changed. Trigger-maintained.';
comment on column public.staff.services_updated_by is
    'Who made that change (= id for a barber self-change). NULL = unknown/system. Trigger-maintained.';

create or replace function public._staff_stamp_services_change()
returns trigger language plpgsql set search_path = public as $$
begin
    if new.capability_service_ids is distinct from old.capability_service_ids
       or new.specialty_service_ids is distinct from old.specialty_service_ids then
        new.services_updated_at := now();
        new.services_updated_by := auth.uid();   -- null for SQL editor/service role
    else
        new.services_updated_at := old.services_updated_at;
        new.services_updated_by := old.services_updated_by;
    end if;
    return new;
end $$;

revoke all on function public._staff_stamp_services_change() from public, anon, authenticated;

drop trigger if exists staff_stamp_services_change on public.staff;
create trigger staff_stamp_services_change
    before update on public.staff
    for each row execute function public._staff_stamp_services_change();
