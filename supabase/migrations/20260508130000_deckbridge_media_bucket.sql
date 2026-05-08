insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'deckbridge-media',
  'deckbridge-media',
  false,
  104857600,
  array[
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'audio/mp4',
    'video/mp4',
    'application/octet-stream'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
