-- Beard / moustache / sideburn services are for adults only (Fahru,
-- 2026-10-13): "sekiranya ada servis untuk Cukur Jambang/Janggut/Misai,
-- tidak pada kanak-kanak".
-- The "Janggut / Misai / Jambang" service type already defaults to
-- target 'dewasa', and _validate_service_selection() refuses mixing a
-- 'dewasa' service with a 'kanak' one. This makes the default a rule, so a
-- facial service can never be saved as 'semua' or 'kanak' (which would let
-- it be combined with Gunting Kanak-kanak). No existing rows are affected
-- (checked on the live project before writing this: 0 facial services).
alter table public.services
    add constraint services_facial_adult_only check (type <> 'facial' or target = 'dewasa');
