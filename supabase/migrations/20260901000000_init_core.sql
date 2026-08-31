-- QueueCut core schema: staff, seats, queues, ticket counters.
-- Individual barber accounts (each barber signs in) rather than a shared login.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- staff : one row per signed-in barber or admin, keyed to Supabase Auth
-- ---------------------------------------------------------------------------
create table public.staff (
    id            uuid primary key references auth.users (id) on delete cascade,
    display_name  text not null check (length(btrim(display_name)) between 1 and 60),

    -- Canonical form of the name. UNIQUE here is what makes the round-7 bug
    -- ("Ali" and "ali" counted as two barbers in the sales report) impossible
    -- rather than something application code has to keep normalising.
    name_key      text generated always as
                      (lower(regexp_replace(btrim(display_name), '\s+', ' ', 'g'))) stored,

    role          text not null default 'barber' check (role in ('barber', 'admin')),

    -- New sign-ups are inactive until an admin approves them, so an account
    -- existing is not the same as an account being able to do anything.
    active        boolean not null default false,
    created_at    timestamptz not null default now()
);

create unique index staff_name_key_uidx on public.staff (name_key);

comment on column public.staff.name_key is
    'Canonical lowercase, whitespace-collapsed display_name. Unique: prevents duplicate barbers.';

-- ---------------------------------------------------------------------------
-- seats : the physical chairs
-- ---------------------------------------------------------------------------
create table public.seats (
    seat_no    integer primary key check (seat_no between 1 and 20),
    active     boolean not null default false,
    barber_id  uuid references public.staff (id) on delete set null,

    -- The round-7 invariant, enforced by the database instead of by four
    -- separate guards in the UI: an open chair always has someone in it.
    constraint seats_active_requires_barber check (not active or barber_id is not null)
);

-- ---------------------------------------------------------------------------
-- queues : the core operational table
-- ---------------------------------------------------------------------------
create table public.queues (
    id                text primary key,
    ticket_no         text not null,

    name              text not null check (length(btrim(name)) between 1 and 60),

    -- Customers write this; nobody but staff can read it back. Enforced by the
    -- column grants in 20260901000100_rls_policies.sql.
    phone             text,

    -- Held by the customer's browser, never readable over the API. Cancelling
    -- your own ticket goes through cancel_own_ticket(), which verifies it.
    claim_token       uuid not null,

    service           text not null,
    duration_minutes  integer not null default 25 check (duration_minutes between 1 and 480),

    -- Integer sen, not a float. Retires the rounding bug class from round 3.
    price_sen         integer not null default 0 check (price_sen >= 0),

    seat_no           integer references public.seats (seat_no) on delete set null,
    barber_id         uuid    references public.staff (id) on delete set null,

    status            text not null default 'waiting'
                          check (status in ('waiting', 'serving', 'done', 'cancelled')),
    source            text not null default 'walkin' check (source in ('walkin', 'booking')),
    is_fast_pass      boolean not null default false,

    created_at        timestamptz not null default now(),
    called_at         timestamptz,
    completed_at      timestamptz,
    cancelled_at      timestamptz,
    cancelled_by      uuid references public.staff (id) on delete set null,
    cancel_reason     text check (cancel_reason is null or length(btrim(cancel_reason)) >= 3),

    version           integer not null default 1,

    -- A customer being served is in a specific chair with a specific barber.
    constraint queues_serving_is_seated check (
        status <> 'serving'
        or (seat_no is not null and barber_id is not null and called_at is not null)),

    constraint queues_done_has_completion check (
        status <> 'done' or completed_at is not null),

    constraint queues_cancelled_has_reason check (
        status <> 'cancelled' or (cancelled_at is not null and cancel_reason is not null))
);

-- Most reads are "who is waiting or being served right now". A partial index
-- keeps that fast as completed history accumulates.
create index queues_active_idx on public.queues (status, created_at)
    where status in ('waiting', 'serving');

create index queues_history_idx on public.queues (completed_at desc)
    where status = 'done';

create index queues_barber_idx on public.queues (barber_id, completed_at)
    where status = 'done';

-- One chair, one customer.
create unique index queues_one_customer_per_seat_uidx on public.queues (seat_no)
    where status = 'serving';

-- ---------------------------------------------------------------------------
-- ticket_counters : server-side daily sequence
-- ---------------------------------------------------------------------------
create table public.ticket_counters (
    counter_date date primary key,
    last_value   integer not null default 0 check (last_value >= 0)
);

-- ---------------------------------------------------------------------------
-- version bump : optimistic concurrency, enforced server-side
-- ---------------------------------------------------------------------------
create or replace function public.bump_row_version()
returns trigger language plpgsql set search_path = public as $$
begin
    new.version := old.version + 1;
    return new;
end $$;

create trigger queues_bump_version
    before update on public.queues
    for each row execute function public.bump_row_version();

-- ---------------------------------------------------------------------------
-- new sign-ups get an inactive staff row automatically
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_staff_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.staff (id, display_name, role, active)
    values (new.id,
            coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)),
            'barber',
            false)
    on conflict (id) do nothing;
    return new;
end $$;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_staff_user();

-- Live updates across devices; replaces the prototype's `storage` event, which
-- only ever worked between tabs of one browser.
alter publication supabase_realtime add table public.queues;
alter publication supabase_realtime add table public.seats;
