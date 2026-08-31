-- Row Level Security.
--
-- The Supabase anon key is public by design: it ships in index.html and anyone
-- can read it. RLS is what actually protects the data, so these policies are the
-- real security boundary — not the fact that the admin panel is behind a button.

-- ---------------------------------------------------------------------------
-- helpers
--
-- SECURITY DEFINER so they bypass RLS on public.staff. Without that, a policy on
-- staff that reads staff recurses infinitely. search_path is pinned because a
-- SECURITY DEFINER function with a mutable search_path is a privilege-escalation
-- hole.
-- ---------------------------------------------------------------------------
create or replace function public.is_active_staff()
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.staff where id = auth.uid() and active);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.staff where id = auth.uid() and active and role = 'admin');
$$;

alter table public.staff           enable row level security;
alter table public.seats           enable row level security;
alter table public.queues          enable row level security;
alter table public.ticket_counters enable row level security;

-- ---------------------------------------------------------------------------
-- staff
-- ---------------------------------------------------------------------------
create policy "staff read themselves and colleagues"
    on public.staff for select to authenticated
    using (id = auth.uid() or public.is_active_staff());

create policy "staff update own display name"
    on public.staff for update to authenticated
    using (id = auth.uid()) with check (id = auth.uid());

create policy "admins manage staff"
    on public.staff for all to authenticated
    using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- seats : everyone sees the chairs, only admins rearrange them
-- ---------------------------------------------------------------------------
create policy "seats readable by all" on public.seats for select to anon, authenticated using (true);

create policy "admins manage seats"
    on public.seats for all to authenticated
    using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- queues
-- ---------------------------------------------------------------------------

-- The TV display and the customer view need to read the queue without an account.
create policy "queue readable by all" on public.queues for select to anon, authenticated using (true);

-- A customer may join the queue, but only as a plain waiting walk-in. Without
-- these constraints anyone could POST themselves in as `serving`, on a seat,
-- with a fast pass.
create policy "anon may take a ticket"
    on public.queues for insert to anon
    with check (
        status = 'waiting'
        and source = 'walkin'
        and seat_no is null
        and barber_id is null
        and is_fast_pass = false
        and called_at is null
        and completed_at is null
        and cancelled_at is null
        and cancelled_by is null
        and version = 1
    );

create policy "staff may take a ticket for a walk-in"
    on public.queues for insert to authenticated
    with check (public.is_active_staff());

create policy "staff manage the queue"
    on public.queues for update to authenticated
    using (public.is_active_staff()) with check (public.is_active_staff());

-- Deliberately no DELETE policy anywhere. Cancellation is a status change, so the
-- record and its reason survive for the report and the audit trail.

-- ---------------------------------------------------------------------------
-- column privileges : phone is write-only for anon
--
-- RLS decides which ROWS are visible; these grants decide which COLUMNS. Without
-- them, "queue readable by all" would publish every customer's phone number to
-- anyone who opens the API.
-- ---------------------------------------------------------------------------
revoke all on public.queues from anon, authenticated;

grant select (id, ticket_no, name, service, duration_minutes, seat_no, barber_id,
              status, source, is_fast_pass, created_at, called_at)
    on public.queues to anon;

grant insert (id, ticket_no, name, phone, claim_token, service,
              duration_minutes, price_sen, source)
    on public.queues to anon;

grant select, insert, update on public.queues to authenticated;

revoke all on public.staff from anon;
grant select, update on public.staff to authenticated;
grant insert, delete on public.staff to authenticated;

revoke all on public.seats from anon, authenticated;
grant select on public.seats to anon, authenticated;
grant insert, update, delete on public.seats to authenticated;

-- Counters are only ever touched through next_ticket_number().
revoke all on public.ticket_counters from anon, authenticated;
