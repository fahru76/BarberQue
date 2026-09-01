-- Migration step 5b: shop settings (public.shop_settings).
--
-- A SINGLETON table — exactly one row, ever. `id boolean primary key default
-- true` plus `check (id)` makes a second row structurally impossible (a row
-- with id=false fails the check; a second row with id=true collides with the
-- primary key). This is the standard singleton-table idiom.
--
-- Deliberately created EMPTY (0 rows), same as `public.seats` in step 2 — the
-- one row is inserted by the client the first time it ever finds this table
-- empty, seeded from whatever this device's real, already-configured local
-- settings are (see js/repositories/shopSettingsRepository.js and the
-- Supabase bridge module script in index.html). Seeding it with generic
-- defaults here instead would silently overwrite the shop's real configured
-- hours/announcement/etc. the first time any client reads it back.
--
-- Column set and defaults mirror index.html's existing getters exactly
-- (getAppName, getShopName, getShopMapLink, ..., getWeeklyOpHours) — see
-- HANDOFF.md step 5b for the full mapping. `closed_dates` and
-- `weekly_op_hours` are the first jsonb columns in this schema; a
-- `jsonb_typeof` check catches gross shape corruption without trying to
-- fully validate their structure in SQL (that validation already happens
-- client-side, same as it does today for these two keys locally).
create table public.shop_settings (
    id boolean primary key default true,
    constraint shop_settings_singleton check (id),

    app_name text not null default 'QueueCut'
        check (length(btrim(app_name)) between 1 and 60),
    shop_name text not null default 'Syam Barber Shop'
        check (length(btrim(shop_name)) between 1 and 80),
    shop_map_link text not null default 'https://www.google.com/maps/search/?api=1&query=FCQQ%2BX6%20Kerteh%2C%20Terengganu',
    shop_map_query text not null default 'FCQQ+X6 Kerteh, Terengganu',
    shop_map_address text not null default 'FCQQ+X6 Kerteh, Terengganu',
    shop_location_name text not null default 'Kerteh',
    shop_announcement text not null default '',
    shop_announcement_html text not null default '',
    shop_announcement_enabled boolean not null default true,
    shop_status text not null default 'open' check (shop_status in ('open', 'closed')),
    shop_status_changed_at timestamptz,
    max_queue integer not null default 10 check (max_queue between 1 and 999),
    seat_count integer not null default 3 check (seat_count between 1 and 20),
    closed_dates jsonb not null default '[]'::jsonb
        check (jsonb_typeof(closed_dates) = 'array'),
    booking_advance_days integer not null default 30 check (booking_advance_days between 1 and 365),
    weekly_op_hours jsonb not null default '{}'::jsonb
        check (jsonb_typeof(weekly_op_hours) = 'object')
);

alter table public.shop_settings enable row level security;

-- Every one of these settings is shown to customers somewhere (shop
-- identity, hours, announcement, open/closed status, max queue length,
-- closed dates, booking window) — unlike `services`, there is no
-- active/inactive row-level split to make here, so this is a flat "readable
-- by everyone" policy.
create policy "shop settings readable by all"
    on public.shop_settings for select
    to anon, authenticated
    using (true);

-- Split into seed (insert) and update rather than one "for all" policy,
-- deliberately WITHOUT a delete policy — same "no DELETE policy anywhere"
-- reasoning as the rest of this schema (see the design-decisions section of
-- HANDOFF.md), except here the reason is simpler: deleting the one
-- shop_settings row breaks the entire site for every device, and there is no
-- legitimate reason for that action to exist at all, so it isn't granted to
-- anyone — not even admins.
create policy "admins seed shop settings"
    on public.shop_settings for insert
    to authenticated
    with check (public.is_admin());

create policy "admins update shop settings"
    on public.shop_settings for update
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());

revoke all on public.shop_settings from anon, authenticated;
grant select on public.shop_settings to anon, authenticated;
grant insert, update on public.shop_settings to authenticated;
