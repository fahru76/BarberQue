-- Migration: sync the admin sidebar menu order across devices.
--
-- Until now `adminSidebarOrder` (see getAdminSectionOrder() /
-- saveAdminSectionOrder() in index.html) lived only in each browser's
-- localStorage, with no server copy at all -- so an admin who reordered the
-- Panel Admin menu on their desktop saw a different order on their phone,
-- because the two devices were never talking to each other. This column
-- rides the exact same shop_settings singleton + snapshot/sync pipeline
-- every OTHER admin-configured setting already uses (see
-- collectCurrentShopSettingsSnapshot() / syncShopSettingsToServer() in
-- index.html, and js/repositories/shopSettingsRepository.js), so any device
-- that signs in as admin now converges on the same order.
--
-- Not null with a default (same convention as every other column here):
-- the default lists all ten current section ids in their original
-- (pre-reorder) order, so a brand-new row -- created by whichever admin
-- device seeds shop_settings first -- starts from a sane value instead of
-- an empty array. `jsonb_typeof` check mirrors closed_dates' array check
-- just above it; full "is this exactly the ten known section ids, no more
-- no less" validation stays client-side, same as closed_dates today.
--
-- Unlike every other shop_settings column, this one is NOT customer-facing
-- (it only affects what an admin sees inside Panel Admin) -- it rides this
-- table anyway because it's the one existing "one admin-set value, synced
-- to every device" mechanism in this app, and a second table + RLS pair for
-- a single small preference would be a lot of new surface for what this is.
-- The "readable by all" policy on shop_settings therefore also exposes this
-- column to anon/customer sessions; that's harmless (it's just a list of
-- ten known section-id strings, nothing sensitive), so no RLS change here.
alter table public.shop_settings
    add column admin_sidebar_order jsonb not null
        default '["staff","shop","announcement","reports","fastpass","cancellations","closedDates","services","hours","seats"]'::jsonb
        check (jsonb_typeof(admin_sidebar_order) = 'array');
