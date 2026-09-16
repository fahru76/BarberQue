-- ---------------------------------------------------------------------------
-- Bug-hunt audit (2026-09-15), LOW item confirmed 2026-09-16: Supabase
-- Realtime's "Postgres Changes" authorizes by ROW only (its own RLS policy),
-- not by column grant -- confirmed against Supabase's own docs ("database
-- records are sent only to clients who are allowed to read them based on
-- your RLS policies", no mention of column-level filtering anywhere in the
-- Postgres Changes docs). Since "queue readable by anon"/"appointments
-- readable by anon" are `using (true)`, anyone holding this project's public
-- anon key could open their own raw websocket connection directly to
-- Supabase Realtime -- bypassing this app's UI, and this repository's own
-- JS, entirely -- and subscribe to `postgres_changes` on `public.queues`/
-- `public.appointments` to receive the FULL row for every ticket/booking,
-- including `phone` and `price_sen`, even though PostgREST correctly hides
-- those columns from anon via column grants.
--
-- This app's own client code was already defensively designed around this
-- (see the "Deliberately does NOT hand the payload's row data to the
-- caller" comments in queueRepository.js/appointmentRepository.js,
-- predating this audit) -- subscribeQueueChanges()/subscribeAppointmentChanges()
-- never read the postgres_changes payload, only used it as a "something
-- changed, go refetch" trigger through the properly column-gated
-- PostgREST/RPC path. So no leak happens through *this app's own* use of
-- Realtime -- but the exposure is still real for anyone who writes their
-- own client against the (intentionally public, non-secret) anon key.
--
-- Fix: switch `queues`/`appointments` from Postgres Changes to Realtime's
-- "Broadcast from Database" feature, which sends only whatever payload a
-- trigger explicitly constructs -- never a WAL-sourced full row. Since this
-- app's client already discards the payload entirely (see above), the
-- broadcast payload here carries NO row data at all, not even a trimmed
-- "safe" column subset -- there is nothing in it for anon or authenticated
-- to inspect either way. `seats` is unaffected -- it has no sensitive
-- columns (seat_no, active, barber_id), so it stays on Postgres Changes.
--
-- NOTE (not something a migration can do): Realtime project settings has an
-- "Allow public access" toggle that Supabase recommends disabling to fully
-- enforce private channels end-to-end. Please check
-- Dashboard -> Project Settings -> Realtime -> Realtime Settings for this
-- project and disable it if it's on.
-- ---------------------------------------------------------------------------

-- ---- 1. Realtime Authorization: which clients may RECEIVE broadcasts -----
--
-- Both topics are readable by anon AND authenticated. `queues-changes` is
-- read by every device (see index.html: "every view benefits from at least
-- the anon-safe refresh"); `appointments-changes` is only ever subscribed to
-- by a staff session today, but granting anon read here too is harmless --
-- the payload carries no information regardless of who receives it -- and
-- keeps this one policy simple rather than splitting it by topic/role for a
-- distinction that has no actual confidentiality consequence.

drop policy if exists "clients can receive queue/appointment change broadcasts" on "realtime"."messages";

create policy "clients can receive queue/appointment change broadcasts"
    on "realtime"."messages" for select
    to anon, authenticated
    using (
        realtime.messages.extension = 'broadcast'
        and (select realtime.topic()) in ('queues-changes', 'appointments-changes')
    );

-- ---- 2. Trigger functions: broadcast a bare change signal, no row data ----
--
-- `op` (INSERT/UPDATE/DELETE) is included purely as debugging context if
-- anyone inspects a message later -- it carries no customer information.
-- The DELETE branch is currently unreachable through this app (there is no
-- DELETE policy on either table -- cancellation is a status change, not a
-- row removal, same reasoning as the rest of this schema), but the trigger
-- covers it anyway for correctness/future-proofing rather than silently
-- missing a change class if that ever changes.

create or replace function public._notify_queues_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
    perform realtime.send(jsonb_build_object('op', TG_OP), 'change', 'queues-changes', true);
    return null;
end;
$$;

drop trigger if exists queues_broadcast_change on public.queues;
create trigger queues_broadcast_change
    after insert or update or delete on public.queues
    for each row execute function public._notify_queues_change();

create or replace function public._notify_appointments_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
    perform realtime.send(jsonb_build_object('op', TG_OP), 'change', 'appointments-changes', true);
    return null;
end;
$$;

drop trigger if exists appointments_broadcast_change on public.appointments;
create trigger appointments_broadcast_change
    after insert or update or delete on public.appointments
    for each row execute function public._notify_appointments_change();

-- ---- 3. Stop publishing full-row WAL changes for these two tables --------
--
-- This is the actual leak-closing step; steps 1-2 exist so the live-refresh
-- feature keeps working without it. `seats` stays in this publication
-- unchanged (see header comment).

alter publication supabase_realtime drop table public.queues;
alter publication supabase_realtime drop table public.appointments;
