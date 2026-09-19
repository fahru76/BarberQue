-- Harden the services reset against Supabase safeupdate.
-- The reset intentionally removes every service, but pg-safeupdate requires
-- an explicit predicate for a table-wide DELETE.
create or replace function public.reset_operational_state(p_scope text default 'global')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_live_queues integer;
    v_upcoming_appointments integer;
    v_default_service_id text := 'SVC-DEFAULT-GUNTING-BIASA';
    v_weekly jsonb := jsonb_build_object(
        '0', jsonb_build_object('closed', false, 'open', '10:00', 'close', '22:00', 'break1Start', '', 'break1End', '', 'break2Start', '', 'break2End', '', 'sessionSplit1', '', 'sessionSplit2', ''),
        '1', jsonb_build_object('closed', false, 'open', '10:00', 'close', '22:00', 'break1Start', '', 'break1End', '', 'break2Start', '', 'break2End', '', 'sessionSplit1', '', 'sessionSplit2', ''),
        '2', jsonb_build_object('closed', false, 'open', '10:00', 'close', '22:00', 'break1Start', '', 'break1End', '', 'break2Start', '', 'break2End', '', 'sessionSplit1', '', 'sessionSplit2', ''),
        '3', jsonb_build_object('closed', false, 'open', '10:00', 'close', '22:00', 'break1Start', '', 'break1End', '', 'break2Start', '', 'break2End', '', 'sessionSplit1', '', 'sessionSplit2', ''),
        '4', jsonb_build_object('closed', false, 'open', '10:00', 'close', '22:00', 'break1Start', '', 'break1End', '', 'break2Start', '', 'break2End', '', 'sessionSplit1', '', 'sessionSplit2', ''),
        '5', jsonb_build_object('closed', false, 'open', '10:00', 'close', '22:00', 'break1Start', '', 'break1End', '', 'break2Start', '', 'break2End', '', 'sessionSplit1', '', 'sessionSplit2', ''),
        '6', jsonb_build_object('closed', false, 'open', '10:00', 'close', '22:00', 'break1Start', '', 'break1End', '', 'break2Start', '', 'break2End', '', 'sessionSplit1', '', 'sessionSplit2', '')
    );
begin
    if not public.is_admin() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;
    if p_scope not in ('global', 'shop', 'announcement', 'closedDates', 'services', 'hours', 'seats') then
        raise exception 'Invalid reset scope' using errcode = '22023';
    end if;

    select count(*) into v_live_queues from public.queues where status in ('waiting', 'serving');
    select count(*) into v_upcoming_appointments from public.appointments where status = 'upcoming';
    if v_live_queues > 0 or v_upcoming_appointments > 0 then
        raise exception 'Reset disekat: masih ada giliran aktif atau tempahan akan datang' using errcode = '55000';
    end if;

    if p_scope in ('global', 'shop') then
        update public.shop_settings set
            app_name = 'QueueCut', shop_name = 'Syam Barber Shop',
            shop_map_link = 'https://www.google.com/maps/search/?api=1&query=FCQQ%2BX6%20Kerteh%2C%20Terengganu',
            shop_map_query = 'FCQQ+X6 Kerteh, Terengganu', shop_map_address = 'FCQQ+X6 Kerteh, Terengganu',
            shop_location_name = 'Kerteh', shop_status = 'open', shop_status_changed_at = null,
            max_queue = 10, seat_count = 3, booking_advance_days = 30,
            closed_dates = '[]'::jsonb, weekly_op_hours = v_weekly
        where id = true;
    end if;
    if p_scope in ('global', 'announcement') then
        update public.shop_settings
           set shop_announcement = '', shop_announcement_html = '', shop_announcement_enabled = true
         where id = true;
    end if;
    if p_scope in ('global', 'closedDates') then
        update public.shop_settings set closed_dates = '[]'::jsonb where id = true;
    end if;
    if p_scope in ('global', 'hours') then
        update public.shop_settings set weekly_op_hours = v_weekly, booking_advance_days = 30 where id = true;
    end if;
    if p_scope in ('global', 'services') then
        delete from public.services where true;
        insert into public.services (id, name, price_sen, duration_minutes, active, category, target, type, sort_order)
        values (v_default_service_id, 'Gunting Biasa', 2000, 30, true, 'asas', 'semua', 'gunting', 0);
        update public.staff
           set capability_service_ids = null, specialty_service_ids = null, service_durations = null
         where true;
    end if;
    if p_scope in ('global', 'seats') then
        delete from public.seats where seat_no > 3;
        insert into public.seats (seat_no, active, barber_id)
        values (1, false, null), (2, false, null), (3, false, null)
        on conflict (seat_no) do update set active = false, barber_id = null;
        update public.shop_settings set seat_count = 3 where id = true;
    end if;

    return jsonb_build_object('scope', p_scope, 'liveQueues', v_live_queues, 'upcomingAppointments', v_upcoming_appointments);
end $$;

revoke all on function public.reset_operational_state(text) from public, anon, authenticated;
grant execute on function public.reset_operational_state(text) to authenticated;
