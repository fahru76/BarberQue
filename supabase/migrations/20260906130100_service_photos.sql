-- Item 3 of QUEUECUT_HANDOVER.md: style photo preview (front + back).
--
-- Architecture decision already locked in by that doc (do not revert to the
-- announcement-image pattern): the services list is fetched on every
-- customer page load (walk-in form, booking form, style picker), so
-- embedding base64 images directly on the `services` row -- the way the
-- announcement editor stores its images -- would drag full image payloads
-- through every one of those fetches, for every visitor, every time.
-- Supabase Storage instead: a bucket with public read / admin-only write,
-- storing only a URL string on the `services` row.
--
-- `style_notes` (the text half of this feature) already landed in
-- 20260906123700_service_style_notes.sql -- this migration is only the
-- photo half: the two URL columns plus the storage bucket and its policies.

-- ---------------------------------------------------------------------------
-- services: two nullable URL columns, additive, no risk to existing rows.
-- ---------------------------------------------------------------------------
alter table public.services
    add column image_url_front text,
    add column image_url_back  text;

comment on column public.services.image_url_front is
    'Public Supabase Storage URL (service-photos bucket) for the front-view style photo. NULL = no photo yet -- customer UI must degrade gracefully (QUEUECUT_HANDOVER.md Item 3), never show a broken image icon.';
comment on column public.services.image_url_back is
    'Same as image_url_front, back view. Independently optional -- a service can have a front photo with no back photo.';

-- ---------------------------------------------------------------------------
-- storage: service-photos bucket, public read / admin-only write.
--
-- Mirrors the "admins manage services" shape from 20260901000400_services_
-- catalog.sql (is_admin() gate), applied here to storage.objects instead of
-- a table. Policies are scoped to bucket_id = 'service-photos' so they can
-- never affect any other bucket this project might add later.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('service-photos', 'service-photos', true)
on conflict (id) do nothing;

create policy "service photos publicly readable"
    on storage.objects for select
    to anon, authenticated
    using (bucket_id = 'service-photos');

create policy "admins upload service photos"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'service-photos' and public.is_admin());

create policy "admins replace service photos"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'service-photos' and public.is_admin())
    with check (bucket_id = 'service-photos' and public.is_admin());

create policy "admins delete service photos"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'service-photos' and public.is_admin());
