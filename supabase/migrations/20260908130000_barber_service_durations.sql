-- Migration: per-barber service duration overrides.
--
-- Fahru's request: any registered barber should be able to have their own
-- timing for a given hairstyle/service, distinct from the shop-wide
-- services.duration_minutes. Admin-entered (extends the existing "Kebolehan
-- & Keutamaan Servis" panel per staff member, same as item 1's
-- capability_service_ids/specialty_service_ids), and feeds into live wait
-- math at the one point a ticket's barber AND service are both certain:
-- call_next_customer(). It does NOT touch the pre-call estimate shown to a
-- customer before they join (no barber is assigned to a waiting ticket yet,
-- so there is nothing barber-specific to show), and it deliberately never
-- re-derives from live public.services data -- that would violate the
-- existing "a service edited/deleted later must not change a ticket already
-- taken" snapshot invariant (see item 1's migration and HANDOFF.md's design
-- decisions). Only the barber's own previously-declared numbers are used.
--
-- ---------------------------------------------------------------------------
-- staff: service_durations
-- ---------------------------------------------------------------------------
alter table public.staff
    add column service_durations jsonb;

comment on column public.staff.service_durations is
    'Per-service duration override in minutes for this barber, e.g. {"svc_123": 20}. Keys are services.id; NULL/missing key = use services.duration_minutes (the shop-wide default) for that service. Set by an admin via the "Kebolehan & Keutamaan Servis" panel. Applied by call_next_customer() only when EVERY service on the ticket has an explicit override -- partial coverage falls back to the ticket''s original snapshotted duration_minutes unchanged, never blended with live services data.';

-- No RLS/grant change needed: this is a plain column on public.staff, already
-- covered by the existing "admins manage staff" (for all, using is_admin())
-- and "staff read colleagues" policies from 20260901000100_rls_policies.sql.
-- call_next_customer() reads it as SECURITY DEFINER, which bypasses RLS
-- entirely, same as every other staff column it already reads
-- (capability_service_ids/specialty_service_ids).

-- ---------------------------------------------------------------------------
-- call_next_customer(): apply the assigned barber's override, if complete
-- ---------------------------------------------------------------------------
create or replace function public.call_next_customer(p_seat_no integer)
returns public.queues language plpgsql security definer set search_path = public as $$
declare
    v_barber             uuid := auth.uid();
    v_seat_barber        uuid;
    v_capability         text[];
    v_specialty          text[];
    v_service_durations  jsonb;
    v_covered            boolean;
    v_effective_duration integer;
    v_row                public.queues;
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    select barber_id into v_seat_barber
      from public.seats
     where seat_no = p_seat_no and active;

    if v_seat_barber is null then
        raise exception 'Kerusi % tidak dibuka', p_seat_no using errcode = '22023';
    end if;

    if v_seat_barber <> v_barber and not public.is_admin() then
        raise exception 'Anda tidak ditugaskan pada kerusi ini' using errcode = '42501';
    end if;

    if exists (select 1 from public.queues where seat_no = p_seat_no and status = 'serving') then
        raise exception 'Kerusi % masih melayan pelanggan', p_seat_no using errcode = '22023';
    end if;

    select capability_service_ids, specialty_service_ids, service_durations
      into v_capability, v_specialty, v_service_durations
      from public.staff where id = v_seat_barber;

    -- Tier 1: specialty match. A ticket with NULL service_ids can never
    -- satisfy a specialty (unlike tier 2, an unknown service is not treated
    -- as a specialty match -- "no preference" isn't the same as "matches
    -- everything"). Same tie-break ordering as before: fast-pass, then
    -- booking, then FIFO; SKIP LOCKED so two barbers calling together take
    -- different customers instead of blocking or double-calling.
    if v_specialty is not null and array_length(v_specialty, 1) > 0 then
        select * into v_row
          from public.queues
         where status = 'waiting'
           and service_ids is not null
           and service_ids && v_specialty
         order by (case when is_fast_pass then 0 when source = 'booking' then 1 else 2 end), created_at
         limit 1
           for update skip locked;
    end if;

    -- Tier 2: capability match, only attempted when tier 1 matched nothing.
    -- v_capability is null = unrestricted. service_ids is null = unknown
    -- service (legacy row, or any path that hasn't been updated) -- treated
    -- as compatible with any capability list rather than excluded.
    if v_row.id is null then
        select * into v_row
          from public.queues
         where status = 'waiting'
           and (v_capability is null or service_ids is null or service_ids && v_capability)
         order by (case when is_fast_pass then 0 when source = 'booking' then 1 else 2 end), created_at
         limit 1
           for update skip locked;
    end if;

    if v_row.id is null then
        raise exception 'Tiada pelanggan menunggu untuk servis yang anda boleh buat' using errcode = 'P0002';
    end if;

    -- Barber-specific duration override: only applied when this barber has
    -- an explicit, well-formed (1-999 minute) override for EVERY service on
    -- the ticket. Any gap, malformed value, or unknown service_ids falls
    -- back to the ticket's original duration_minutes untouched -- fail-safe
    -- by construction, so a bad/missing override can never break calling a
    -- customer in.
    v_effective_duration := null;
    if v_row.service_ids is not null and array_length(v_row.service_ids, 1) > 0
       and v_service_durations is not null then
        select bool_and(
                 v_service_durations ? svc_id
                 and (v_service_durations ->> svc_id) ~ '^[1-9][0-9]{0,2}$'
               )
          into v_covered
          from unnest(v_row.service_ids) as svc_id;

        if coalesce(v_covered, false) then
            select sum((v_service_durations ->> svc_id)::integer)
              into v_effective_duration
              from unnest(v_row.service_ids) as svc_id;
        end if;
    end if;

    update public.queues
       set status           = 'serving',
           seat_no          = p_seat_no,
           barber_id        = coalesce(v_seat_barber, v_barber),
           called_at        = now(),
           duration_minutes = case
                                 when v_effective_duration between 1 and 480 then v_effective_duration
                                 else duration_minutes
                               end
     where id = v_row.id
    returning * into v_row;

    return v_row;
end $$;

-- Grants unchanged (create or replace preserves them; restated as cheap
-- insurance, same convention as every prior redefinition of this function).
revoke all on function public.call_next_customer(integer) from public;
revoke all on function public.call_next_customer(integer) from anon;
grant execute on function public.call_next_customer(integer) to authenticated;
