-- Add JioSaavn-specific metadata columns to tracks
-- Safe to run multiple times (uses IF NOT EXISTS)

ALTER TABLE public.tracks
  ADD COLUMN IF NOT EXISTS ext_track_id text,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS language text,
  ADD COLUMN IF NOT EXISTS release_date date,
  ADD COLUMN IF NOT EXISTS year smallint,
  ADD COLUMN IF NOT EXISTS jio_type text,
  ADD COLUMN IF NOT EXISTS music text,
  ADD COLUMN IF NOT EXISTS music_id text,
  ADD COLUMN IF NOT EXISTS primary_artists text,
  ADD COLUMN IF NOT EXISTS primary_artists_id text,
  ADD COLUMN IF NOT EXISTS featured_artists text,
  ADD COLUMN IF NOT EXISTS featured_artists_id text,
  ADD COLUMN IF NOT EXISTS singers text,
  ADD COLUMN IF NOT EXISTS starring text,
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS label_id text,
  ADD COLUMN IF NOT EXISTS label_url text,
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS is_drm boolean,
  ADD COLUMN IF NOT EXISTS has_320kbps boolean,
  ADD COLUMN IF NOT EXISTS is_dolby_content boolean,
  ADD COLUMN IF NOT EXISTS has_lyrics boolean,
  ADD COLUMN IF NOT EXISTS lyrics_snippet text,
  ADD COLUMN IF NOT EXISTS copyright_text text,
  ADD COLUMN IF NOT EXISTS encrypted_drm_media_url text,
  ADD COLUMN IF NOT EXISTS encrypted_media_url text,
  ADD COLUMN IF NOT EXISTS encrypted_media_path text,
  ADD COLUMN IF NOT EXISTS media_preview_url text,
  ADD COLUMN IF NOT EXISTS perma_url text,
  ADD COLUMN IF NOT EXISTS album_url text,
  ADD COLUMN IF NOT EXISTS rights jsonb,
  ADD COLUMN IF NOT EXISTS artist_map jsonb,
  ADD COLUMN IF NOT EXISTS webp boolean,
  ADD COLUMN IF NOT EXISTS cache_state boolean,
  ADD COLUMN IF NOT EXISTS starred boolean,
  ADD COLUMN IF NOT EXISTS vcode text,
  ADD COLUMN IF NOT EXISTS vlink text,
  ADD COLUMN IF NOT EXISTS triller_available boolean,
  ADD COLUMN IF NOT EXISTS external_payload jsonb;

-- Defaults for new inserts
ALTER TABLE public.tracks
  ALTER COLUMN source SET DEFAULT 'jiosaavn',
  ALTER COLUMN cache_state SET DEFAULT false,
  ALTER COLUMN starred SET DEFAULT false,
  ALTER COLUMN has_320kbps SET DEFAULT false,
  ALTER COLUMN is_drm SET DEFAULT false,
  ALTER COLUMN is_dolby_content SET DEFAULT false,
  ALTER COLUMN has_lyrics SET DEFAULT false,
  ALTER COLUMN webp SET DEFAULT false,
  ALTER COLUMN triller_available SET DEFAULT false;

-- Indexes useful for import dedupe and lookups
CREATE UNIQUE INDEX IF NOT EXISTS tracks_ext_track_id_uq
  ON public.tracks (ext_track_id)
  WHERE ext_track_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tracks_source_idx
  ON public.tracks (source);

CREATE INDEX IF NOT EXISTS tracks_language_idx
  ON public.tracks (language);

CREATE INDEX IF NOT EXISTS tracks_release_date_idx
  ON public.tracks (release_date);

CREATE INDEX IF NOT EXISTS tracks_label_idx
  ON public.tracks (label);

CREATE INDEX IF NOT EXISTS tracks_music_idx
  ON public.tracks (music);
