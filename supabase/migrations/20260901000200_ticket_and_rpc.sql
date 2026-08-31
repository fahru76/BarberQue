-- Server-side ticket numbering and the RPCs the browser calls.

-- ---------------------------------------------------------------------------
-- next_ticket_number
--
-- Fixes the collision found in the very first audit: the prototype kept the
-- counter in localStorage, so two phones on the same day both minted PG01 and
-- the de-duplication check could not see across devices.
--
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING is a single atomic statement:
-- concurrent callers serialise on the row lock and each gets a distinct value.
-- ---------------------------------------------------------------------------
create or replace function public.next_ticket_number(p_prefix text)
returns text language plpgsql security definer set search_path = public as $$
declare
    v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
    v_next  integer;
begin
    if p_prefix is null or p_prefix !~ '^[A-Z]{2,4}$' then
        raise exception 'Invalid ticket prefix: %', p_prefix using errcode = '22023';
    end if;

    insert into public.ticket_counters (counter_date, last_value)
    values (v_today, 1)
    on conflict (counter_date) do update
        set last_value = public.ticket_counters.last_value + 1
    returning last_value into v_next;

    -- Date suffix keeps ids unique across days; getDisplayTicketId() in the client
    -- strips it so the customer still sees a short "PG01".
    return p_prefix || lpad(v_next::text, 2, '0') || '-' || to_char(v_today, 'YYYYMMDD');
end $$;

revoke all on function public.next_ticket_number(text) from public;
grant execute on function public.next_ticket_number(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- cancel_own_ticket
--
-- A walk-in customer has no account, so they cannot be given an UPDATE policy
-- without also being able to cancel other people's tickets. Instead the browser
-- keeps the claim_token it generated at insert time and passes it here. The
-- token column is never selectable over the API.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_own_ticket(p_id text, p_claim_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
    v_updated integer;
begin
    update public.queues
       set status        = 'cancelled',
           cancelled_at  = now(),
           cancel_reason = 'Dibatalkan oleh pelanggan'
     where id = p_id
       and claim_token = p_claim_token
       and status = 'waiting';

    get diagnostics v_updated = row_count;
    return v_updated = 1;
end $$;

revoke all on function public.cancel_own_ticket(text, uuid) from public;
grant execute on function public.cancel_own_ticket(text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- call_next_customer
--
-- Wrapped in a function rather than done as two client updates so that claiming
-- a seat and marking the customer as serving cannot half-succeed — the round-5
-- non-atomic-write problem, solved by the transaction boundary instead of by a
-- rollback helper.
-- ---------------------------------------------------------------------------
create or replace function public.call_next_customer(p_seat_no integer)
returns public.queues language plpgsql security definer set search_path = public as $$
declare
    v_barber uuid := auth.uid();
    v_row    public.queues;
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    if not exists (select 1 from public.seats
                    where seat_no = p_seat_no and active and barber_id is not null) then
        raise exception 'Kerusi % tidak dibuka', p_seat_no using errcode = '22023';
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
           barber_id = coalesce((select barber_id from public.seats where seat_no = p_seat_no), v_barber),
           called_at = now()
     where id = v_row.id
    returning * into v_row;

    return v_row;
end $$;

revoke all on function public.call_next_customer(integer) from public;
grant execute on function public.call_next_customer(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- complete_service
-- ---------------------------------------------------------------------------
create or replace function public.complete_service(p_id text)
returns public.queues language plpgsql security definer set search_path = public as $$
declare v_row public.queues;
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    update public.queues
       set status = 'done', completed_at = now()
     where id = p_id and status = 'serving'
    returning * into v_row;

    if not found then
        raise exception 'Tiada pelanggan sedang dilayan untuk id %', p_id using errcode = 'P0002';
    end if;
    return v_row;
end $$;

revoke all on function public.complete_service(text) from public;
grant execute on function public.complete_service(text) to authenticated;

-- ---------------------------------------------------------------------------
-- barber_performance : the sales report, grouped by staff id
--
-- Grouping on a foreign key rather than a name string is what makes the round-7
-- "Ali vs ali" split impossible.
-- ---------------------------------------------------------------------------
create or replace function public.barber_performance(p_from date, p_to date)
returns table (barber_id uuid, display_name text, customers bigint, sales_sen bigint)
language sql stable security definer set search_path = public as $$
    select s.id,
           s.display_name,
           count(q.id),
           coalesce(sum(q.price_sen), 0)
      from public.staff s
      left join public.queues q
             on q.barber_id = s.id
            and q.status = 'done'
            and (q.completed_at at time zone 'Asia/Kuala_Lumpur')::date between p_from and p_to
     where s.active
     group by s.id, s.display_name
     order by coalesce(sum(q.price_sen), 0) desc, s.display_name;
$$;

revoke all on function public.barber_performance(date, date) from public;
grant execute on function public.barber_performance(date, date) to authenticated;
