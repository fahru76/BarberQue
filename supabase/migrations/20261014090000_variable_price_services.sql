-- Variable-price services (Fahru, 2026-10-13):
--   "Sekiranya ada service yang harga belum ditentukan bergantung kepada
--    jenis service ... Report nak capture bayaran yang dikenakan."
-- Agreed design: the admin marks a service "harga ikut keadaan" and its price
-- becomes a starting price ("Dari RM30"). When a ticket containing such a
-- service is finished, the barber MUST enter the amount actually paid; the
-- report then sums that amount. The original quote is kept, every change is
-- logged, and only an admin can correct a finished ticket's amount later.
-- Fixed-price services behave exactly as before.

-- 1. schema -----------------------------------------------------------------
alter table public.services
    add column price_is_variable boolean not null default false;

alter table public.queues
    add column quoted_price_sen integer check (quoted_price_sen is null or quoted_price_sen >= 0);

create table public.queue_price_changes (
    id               bigint generated always as identity primary key,
    queue_id         text not null references public.queues (id) on delete cascade,
    old_price_sen    integer not null check (old_price_sen >= 0),
    new_price_sen    integer not null check (new_price_sen >= 0),
    kind             text not null check (kind in ('completion', 'correction')),
    reason           text check (reason is null or length(btrim(reason)) between 3 and 200),
    changed_by       uuid references public.staff (id) on delete set null,
    changed_by_name  text,
    changed_at       timestamptz not null default now()
);
create index queue_price_changes_changed_at_idx on public.queue_price_changes (changed_at);
alter table public.queue_price_changes enable row level security;
revoke all on public.queue_price_changes from public, anon, authenticated;
-- No direct client access: written by complete_service()/admin_set_ticket_price(),
-- read through list_price_changes() (admin only).
create policy "no direct access to price changes" on public.queue_price_changes
    for all to anon, authenticated using (false) with check (false);

-- 2. helper -----------------------------------------------------------------
create or replace function public._ticket_has_variable_price(p_service_ids text[])
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from public.services
         where id = any(coalesce(p_service_ids, '{}'::text[])) and price_is_variable
    );
$$;
revoke all on function public._ticket_has_variable_price(text[]) from public, anon, authenticated;

-- 3. Selesai: amount paid is required for variable-price tickets -------------
-- Signature gains an optional argument, so drop + create (a second overload
-- would make one-argument calls ambiguous). Existing callers that pass only
-- p_id keep working for fixed-price tickets.
drop function if exists public.complete_service(text);

create function public.complete_service(p_id text, p_final_price_sen integer default null)
returns public.queues language plpgsql security definer set search_path = public as $$
declare
    v_row      public.queues;
    v_variable boolean;
    v_old      integer;
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

    v_variable := public._ticket_has_variable_price(v_row.service_ids);
    if v_variable then
        if p_final_price_sen is null then
            raise exception 'Sila masukkan jumlah yang dibayar pelanggan.' using errcode = '22023';
        end if;
        if p_final_price_sen < 0 or p_final_price_sen > 99900 then
            raise exception 'Jumlah dibayar mesti antara RM0 dan RM999.' using errcode = '22023';
        end if;
    elsif p_final_price_sen is not null and p_final_price_sen <> v_row.price_sen then
        raise exception 'Harga servis ini tetap dan tidak boleh diubah semasa Selesai.' using errcode = '22023';
    end if;

    v_old := v_row.price_sen;
    update public.queues
       set status           = 'done',
           completed_at     = now(),
           quoted_price_sen = case when v_variable then coalesce(quoted_price_sen, price_sen) else quoted_price_sen end,
           price_sen        = case when v_variable then p_final_price_sen else price_sen end
     where id = p_id
    returning * into v_row;

    if v_variable then
        insert into public.queue_price_changes
            (queue_id, old_price_sen, new_price_sen, kind, changed_by, changed_by_name)
        select p_id, v_old, p_final_price_sen, 'completion', auth.uid(), s.display_name
          from (select 1) one left join public.staff s on s.id = auth.uid();
    end if;

    return v_row;
end $$;
revoke all on function public.complete_service(text, integer) from public, anon;
grant execute on function public.complete_service(text, integer) to authenticated;

-- 4. admin correction of a finished ticket ----------------------------------
create or replace function public.admin_set_ticket_price(p_id text, p_price_sen integer, p_reason text)
returns public.queues language plpgsql security definer set search_path = public as $$
declare
    v_row    public.queues;
    v_old    integer;
    v_reason text := btrim(coalesce(p_reason, ''));
begin
    if not public.is_admin() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;
    if p_price_sen is null or p_price_sen < 0 or p_price_sen > 99900 then
        raise exception 'Jumlah mesti antara RM0 dan RM999.' using errcode = '22023';
    end if;
    if length(v_reason) < 3 or length(v_reason) > 200 then
        raise exception 'Sila tulis sebab pembetulan (3 hingga 200 aksara).' using errcode = '22023';
    end if;

    select * into v_row from public.queues where id = p_id and status = 'done' for update;
    if not found then
        raise exception 'Hanya tiket yang sudah selesai boleh dibetulkan.' using errcode = 'P0002';
    end if;
    if v_row.price_sen = p_price_sen then
        return v_row;
    end if;

    v_old := v_row.price_sen;
    update public.queues
       set quoted_price_sen = coalesce(quoted_price_sen, price_sen),
           price_sen        = p_price_sen
     where id = p_id
    returning * into v_row;

    insert into public.queue_price_changes
        (queue_id, old_price_sen, new_price_sen, kind, reason, changed_by, changed_by_name)
    select p_id, v_old, p_price_sen, 'correction', v_reason, auth.uid(), s.display_name
      from (select 1) one left join public.staff s on s.id = auth.uid();

    return v_row;
end $$;
revoke all on function public.admin_set_ticket_price(text, integer, text) from public, anon;
grant execute on function public.admin_set_ticket_price(text, integer, text) to authenticated;

-- 5. report: price-change log (admin) ---------------------------------------
create or replace function public.list_price_changes(p_from date, p_to date)
returns table (
    queue_id text, customer_name text, service text, barber_name text,
    old_price_sen integer, new_price_sen integer, kind text, reason text,
    changed_by_name text, changed_at timestamptz
) language plpgsql stable security definer set search_path = public as $$
begin
    if not public.is_admin() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
        raise exception 'Invalid report period';
    end if;
    return query
        select c.queue_id, q.name, q.service, q.barber_name,
               c.old_price_sen, c.new_price_sen, c.kind, c.reason,
               c.changed_by_name, c.changed_at
          from public.queue_price_changes c
          join public.queues q on q.id = c.queue_id
         where public._report_business_date(c.changed_at) between p_from and p_to
         order by c.changed_at desc, c.id desc;
end $$;
revoke all on function public.list_price_changes(date, date) from public, anon;
grant execute on function public.list_price_changes(date, date) to authenticated;

-- 6. report rows also carry the original quote -------------------------------
-- Return type changes, so drop + create. barber_performance() and
-- my_barber_performance() are plpgsql and resolve this at call time.
drop function if exists public.report_completed_tickets(date, date, boolean);

create function public.report_completed_tickets(p_from date, p_to date, p_own boolean default false)
returns table (
    id text, name text, service text, duration_minutes integer, seat_no integer, barber_id uuid,
    barber_name text, status text, source text, is_fast_pass boolean, created_at timestamptz,
    called_at timestamptz, completed_at timestamptz, price_sen integer, service_ids text[],
    quoted_price_sen integer
) language plpgsql stable security definer set search_path = public as $$
begin
    if not public.is_active_staff() then raise exception 'Not authorised' using errcode = '42501'; end if;
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Invalid report period'; end if;
    return query
        select q.id, q.name, q.service, q.duration_minutes, q.seat_no, q.barber_id, q.barber_name, q.status,
               q.source, q.is_fast_pass, q.created_at, q.called_at, q.completed_at, q.price_sen, q.service_ids,
               q.quoted_price_sen
          from public.queues q
         where q.status = 'done'
           and q.completed_at >= (p_from::timestamp at time zone 'Asia/Kuala_Lumpur')
           and q.completed_at < ((p_to + 2)::timestamp at time zone 'Asia/Kuala_Lumpur')
           and public._report_business_date(q.completed_at) between p_from and p_to
           and ((not p_own and public.is_admin()) or q.barber_id = auth.uid())
         order by q.completed_at, q.id;
end $$;
revoke all on function public.report_completed_tickets(date, date, boolean) from public, anon, authenticated;
grant execute on function public.report_completed_tickets(date, date, boolean) to authenticated;
