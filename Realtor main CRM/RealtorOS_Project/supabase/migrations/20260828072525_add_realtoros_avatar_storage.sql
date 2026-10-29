-- RealtorOS profile photos: a private Storage bucket plus per-user RLS so an
-- authenticated user can only ever touch objects inside their own folder
-- (path prefix `${auth.uid()}/...`). No public access; the app reads photos
-- back through short-lived signed URLs (see App.cloud.getAvatarSignedUrl).
--
-- NOTE: this file documents the migration exactly as already applied to the
-- live project (ref yanasorwmaybnabfuepn) — bucket `avatars` and the four
-- realtoros_avatar_*_own policies below already exist there. It is kept here
-- only so the local migration history matches reality; it is not meant to be
-- re-run against that project.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "realtoros_avatar_select_own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "realtoros_avatar_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "realtoros_avatar_update_own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "realtoros_avatar_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
