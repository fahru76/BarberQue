-- Supabase applies DEFAULT PRIVILEGES granting EXECUTE on new public functions to
-- anon and authenticated. "revoke ... from public" does NOT remove those explicit
-- role grants, so after 20260901000200 every RPC was still reachable by anon via
-- /rest/v1/rpc/ — including barber_performance, which had no internal guard and
-- would have returned the whole sales report to anyone holding the public key.
--
-- Revoke per role, not from PUBLIC.

-- Internal RLS helpers. `authenticated` must keep EXECUTE because policy
-- expressions are evaluated as the querying role. No anon policy calls them.
revoke execute on function public.is_active_staff() from anon, public;
revoke execute on function public.is_admin()        from anon, public;

-- Trigger functions are never meant to be callable over the API. PostgreSQL checks
-- EXECUTE on a trigger function at CREATE TRIGGER time, not when it fires, so
-- revoking here does not disable the existing triggers (verified after applying).
revoke execute on function public.bump_row_version()      from anon, authenticated, public;
revoke execute on function public.handle_new_staff_user() from anon, authenticated, public;

-- Staff-only operations.
revoke execute on function public.call_next_customer(integer)    from anon, public;
revoke execute on function public.complete_service(text)         from anon, public;
revoke execute on function public.barber_performance(date, date) from anon, public;

-- Defence in depth: barber_performance is SECURITY DEFINER, so if a later
-- migration re-grants it by accident the guard still stops the report leaking.
-- call_next_customer and complete_service already check is_active_staff().
create or replace function public.barber_performance(p_from date, p_to date)
returns table (barber_id uuid, display_name text, customers bigint, sales_sen bigint)
language plpgsql stable security definer set search_path = public as $$
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    return query
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
end $$;

revoke execute on function public.barber_performance(date, date) from anon, public;
grant  execute on function public.barber_performance(date, date) to authenticated;
