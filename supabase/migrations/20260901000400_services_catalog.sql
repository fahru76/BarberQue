-- Migration step 5a: services/price catalog (public.services).
--
-- Applied live via the Supabase MCP `apply_migration` tool under the name
-- `services_catalog` (server-side migration version 20260831174520). This
-- file is a same-day addition to the local tracked-migrations folder for
-- parity with the other four migrations here — its content was verified
-- against the live table's actual columns, constraints, indexes, RLS
-- policies and grants (information_schema / pg_policies / pg_indexes /
-- role_table_grants), not re-typed from memory.
--
-- Mirrors the queues/seats pattern already established: RLS enabled, a
-- generated `name_key` column + unique index for case/whitespace-insensitive
-- name uniqueness (same technique as staff.display_name), and column set
-- chosen to match exactly what js/repositories/serviceRepository.js reads
-- and writes (see HANDOFF.md, step 5a).
--
-- NOTE: the single combined select policy this migration originally created
-- ("active services readable by all, all services readable by staff", `to
-- anon, authenticated`) had a bug, found during step-5a verification and
-- fixed same-day by 20260901000500_services_anon_policy_fix.sql — see that
-- file for why. Left here unmodified (as originally applied) rather than
-- rewritten, since migrations that already ran should never be edited after
-- the fact; the fix migration is what's actually in effect.

create table public.services (
    id text primary key,
    name text not null check (length(btrim(name)) >= 1 and length(btrim(name)) <= 60),
    name_key text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
    price_sen integer not null check (price_sen >= 0),
    duration_minutes integer not null check (duration_minutes > 0),
    active boolean not null default true,
    category text not null check (category in ('asas', 'fashion')),
    target text not null default 'semua' check (target in ('semua', 'dewasa', 'kanak')),
    type text not null default 'gunting' check (type in ('gunting', 'botak', 'facial', 'lain')),
    sort_order integer not null default 0,
    created_at timestamptz not null default now()
);

create unique index services_name_key_uidx on public.services (name_key);
create index services_category_sort_idx on public.services (category, sort_order);

alter table public.services enable row level security;

-- Anyone (anon or authenticated) may read active services — this is the
-- customer-facing catalog. Authenticated staff (any role; is_active_staff()
-- also requires `active = true` on the staff row) may additionally read
-- inactive ones, since the admin panel needs to show and re-enable them.
create policy "active services readable by all, all services readable by staff"
    on public.services for select
    to anon, authenticated
    using (active or public.is_active_staff());

-- Only admins may create, edit, reorder or delete services — barbers can
-- read the catalog but never modify it. Mirrors the "admins manage staff"
-- policy shape from 20260901000100_rls_policies.sql.
create policy "admins manage services"
    on public.services for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());

revoke all on public.services from anon, authenticated;
grant select on public.services to anon, authenticated;
grant insert, update, delete on public.services to authenticated;
