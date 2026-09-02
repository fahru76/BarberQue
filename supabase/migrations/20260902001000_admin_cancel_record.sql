-- ---------------------------------------------------------------------------
-- admin_cancel_record
--
-- Closes a known, pre-existing gap flagged (not introduced) by step 6: unlike
-- every other admin action added since step 4b (call_next_customer,
-- complete_service, checkin_appointment, approve_fast_pass, revoke_fast_pass),
-- index.html's confirmAdminCancellation() still only wrote 'cancelled' to
-- localStorage -- an admin cancelling a ticket or appointment on one device
-- was invisible to every other device (the display board, another staff
-- phone), the exact same class of bug step 7's live testing already found
-- and fixed for the customer-initiated cancel path (see listQueues()).
--
-- Shaped as one function taking p_source, exactly like approve_fast_pass()/
-- revoke_fast_pass() just above -- index.html's adminCancelRecord(source,
-- recordId) already carries this same {source, recordId} pair end to end
-- (the confirm dialog, the audit log call, the notification enqueue), so the
-- RPC boundary matches the client's existing shape instead of inventing a
-- second one. Admin-only (is_admin()), same as fast-pass approve/revoke --
-- confirmAdminCancellation() is only reachable from admin-app, which is
-- itself gated to staffProfile.role === 'admin' (see index.html's
-- switchView()), so this matches the UI's own authorisation level rather
-- than loosening it to is_active_staff().
--
-- Only a 'waiting' queue row / 'upcoming' appointment can be admin-cancelled
-- -- same precondition the client already checked locally (adminCancelRecord's
-- own isValid guard) and the same one cancel_own_ticket()/
-- cancel_own_appointment() enforce for the customer path. is_fast_pass is
-- cleared (matching the local code's `queue.isFastPass = false` /
-- `appointment.fastPassApproved = false`) but approved_by/approval_reason/
-- approved_at are left as history, exactly as the local code already did --
-- this migration only moves the existing write target from localStorage to
-- the server, it does not change what gets written.
--
-- queues.cancelled_by is a uuid FK to staff (see init_core.sql) -- set from
-- auth.uid(), the verified caller, same convention as approved_by/revoked_by
-- rather than trusting a client-supplied value. appointments.cancelled_by is
-- a plain text check ('customer'|'admin') by contrast (see appointments.sql),
-- so it gets the literal 'admin' there, matching cancel_own_appointment()'s
-- 'customer' literal on the same column.
-- ---------------------------------------------------------------------------
create or replace function public.admin_cancel_record(p_source text, p_id text, p_reason text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_updated integer;
begin
    if not public.is_admin() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;
    if p_reason is null or length(btrim(p_reason)) < 3 then
        raise exception 'Pembatalan Admin memerlukan sebab yang jelas' using errcode = '22023';
    end if;

    if p_source = 'queue' then
        update public.queues
           set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
               cancel_reason = p_reason, is_fast_pass = false, version = version + 1
         where id = p_id and status = 'waiting';
    elsif p_source = 'appointment' then
        update public.appointments
           set status = 'cancelled', cancelled_at = now(), cancelled_by = 'admin',
               cancel_reason = p_reason, is_fast_pass = false, version = version + 1
         where id = p_id and status = 'upcoming';
    else
        raise exception 'Invalid source: %', p_source using errcode = '22023';
    end if;

    get diagnostics v_updated = row_count;
    return v_updated = 1;
end $$;

revoke all on function public.admin_cancel_record(text, text, text) from public;
revoke all on function public.admin_cancel_record(text, text, text) from anon;
grant execute on function public.admin_cancel_record(text, text, text) to authenticated;
