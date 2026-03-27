# Music Schema V2 (Normalized, JioSaavn-ready)

This schema is a clean-slate, production-oriented structure for a streaming app with strong external-provider support.

## Important

- Script is destructive for music-domain tables and assumes no data retention is required.
- Use: `docs/sql/2026-03-23-normalize-core-and-external-schema.sql`.

## Design goals

- Keep core catalog canonical (`artists`, `albums`, `tracks`, `playlists`).
- Model all many-to-many relationships correctly.
- Separate external provider metadata into dedicated tables.
- Keep rich credits normalized for search and filtering.
- Support multiple audio/video assets and HLS variants per track.

## Core tables

- `artists` (1:1 with `users`)
- `albums`
- `tracks`
- `playlists`
- Dimensions: `languages`, `genres`, `labels`

## Relation tables

- `artist_genres`
- `album_artists` (with `role`, `sort_order`)
- `album_genres`
- `track_artists` (with `role`, `sort_order`)
- `track_genres`
- `playlist_tracks` (with strict `position` uniqueness)

## Playback/asset tables

- `track_assets`
  - `audio_progressive`, `audio_hls_master`, `audio_hls_variant`, `audio_hls_segment`, `video`

## Credits tables

- `track_credits` for canonical credits tied to internal artists when available
- `external_track_credits` for provider-native credits tied to external rows

## External provider normalization

- `external_providers`
- `artist_external_refs`
- `album_external_refs`
- `track_external_refs`
- `playlist_external_refs`

This avoids polluting `tracks` with provider-specific columns while preserving full raw payload (`raw_payload`) for future parsing.

## JioSaavn mapping approach

- Canonical fields:
  - `song` -> `tracks.title`
  - `duration` -> `tracks.duration`
  - album metadata -> `albums`
- External identity and payload:
  - `id`, `perma_url`, encrypted URLs, rights, booleans -> `track_external_refs`
  - `artistMap`, `primary_artists`, `featured_artists`, `singers`, `music`, `starring` -> `external_track_credits` + `track_credits`

## Why this is better than flat JioSaavn columns

- Works for any future provider (Spotify/YouTube/etc.) without schema churn.
- Keeps analytics/search on canonical entities stable.
- Preserves provider payload fidelity for debugging and re-processing.
