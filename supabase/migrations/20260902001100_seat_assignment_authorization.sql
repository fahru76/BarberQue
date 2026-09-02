-- ---------------------------------------------------------------------------
-- Seat-assignment authorisation for call_next_customer() / complete_service()
--
-- Requested directly: a barber should only be able to call/complete
-- customers on the seat admin has assigned THEM to -- barber 1 at seat 1
-- must not be able to press "Panggil"/"Selesai" for seat 2 or 3 just because
-- they're signed in as active staff. Previously both functions only checked
-- is_active_staff() -- ANY active barber (or admin) could act on ANY open
-- seat, regardless of public.seats.barber_id.
--
-- Admins are exempted (is_admin() OR the seat-assignment match) -- the
-- request was specifically about barber-to-barber isolation, and admins
-- already have override authority everywhere else in this app (fast-pass,
-- admin-cancel, etc.); there was no ask to also lock admins out of seats
-- they didn't personally assign themselves to.
--
-- complete_service() gets the same treatment for consistency, even though
-- only call_next_customer() ("Panggil") was named explicitly -- leaving it
-- unrestricted would mean barber 2 still couldn't CALL to seat 1, but could
-- mark seat 1's customer done, which is the same gap the request is about,
-- just on the other half of the same action pair. It checks the QUEUES row's
-- own barber_id (set by call_next_customer() at call time), not the SEAT's
-- current assignment -- correct even if the seat gets reassigned mid-service.
-- ---------------------------------------------------------------------------
create or replace function public.call_next_customer(p_seat_no integer)
returns public.queues language plpgsql security definer set search_path = public as $$
declare
    v_barber      uuid := auth.uid();
    v_seat_barber uuid;
    v_row         public.queues;
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

    -- Same ordering as sortWaitingQueue(): fast pass, then booking, then FIFO.
    -- SKIP LOCKED so two barbers pressing "Panggil" together take different
    -- customers instead of blocking or double-calling.
    select * into v_row
      from public.queues
     where status = 'waiting'
     order by (case when is_fast_pass then 0 when source = 'booking' then 1 else 2 end), created_at
     limit 1
       for update skip locked;

    if not found then
        raise exception 'Tiada pelanggan menunggu' using errcode = 'P0002';
    end if;

    update public.queues
       set status    = 'serving',
           seat_no   = p_seat_no,
           barber_id = coalesce(v_seat_barber, v_barber),
           called_at = now()
     where id = v_row.id
    returning * into v_row;

    return v_row;
end $$;

create or replace function public.complete_service(p_id text)
returns public.queues language plpgsql security definer set search_path = public as $$
declare v_row public.queues;
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    select * into v_row from public.queues where id = p_id and status = 'serving' for update;
    if not found then
        raise exception 'Tiada pelanggan sedang dilayan untuk id %', p_id using errcode = 'P0002';
    end if;

    if v_row.barber_id is distinct from auth.uid() and not public.is_admin() then
        raise exception 'Anda tidak ditugaskan pada kerusi ini' using errcode = '42501';
    end if;

    update public.queues
       set status = 'done', completed_at = now()
     where id = p_id
    returning * into v_row;

    return v_row;
end $$;

-- Grants are unchanged (both functions already `to authenticated` only from
-- their original migration) -- create or replace preserves existing grants,
-- but restating them here is cheap insurance against that ever not holding.
revoke all on function public.call_next_customer(integer) from public;
revoke all on function public.call_next_customer(integer) from anon;
grant execute on function public.call_next_customer(integer) to authenticated;

revoke all on function public.complete_service(text) from public;
revoke all on function public.complete_service(text) from anon;
grant execute on function public.complete_service(text) to authenticated;
