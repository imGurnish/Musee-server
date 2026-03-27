# Tracks API

This document reflects the normalized V2 schema and current backend behavior.

Base paths:
- Admin: `/api/admin/tracks`
- User: `/api/user/tracks`

## Schema alignment

- Core table: `tracks`
- Artist links: `track_artists`
- Audio variants: `track_assets` (`asset_type='audio_progressive'`)
- External metadata: `track_external_refs`, `external_track_credits`
- HLS URLs are returned from blob path convention and optional `hls_master_path`

## Track object (admin)

```json
{
  "track_id": "uuid",
  "title": "string",
  "subtitle": "string|null",
  "album_id": "uuid",
  "track_number": 1,
  "disc_number": 1,
  "duration": 215,
  "language_code": "en",
  "lyrics_url": "string|null",
  "lyrics_snippet": "string|null",
  "play_count": 0,
  "is_explicit": false,
  "likes_count": 0,
  "popularity_score": 0,
  "copyright_text": "string|null",
  "label_id": "uuid|null",
  "hls_master_path": "string|null",
  "video_url": "string|null",
  "is_published": true,
  "created_at": "ISO",
  "updated_at": "ISO",
  "hls": {
    "master": "https://.../hls/track_<id>/master.m3u8",
    "variants": [{ "bitrate": 96, "url": "..." }]
  },
  "artists": [{ "artist_id": "uuid", "role": "owner|editor|viewer", "name": "string", "avatar_url": "string|null" }],
  "audios": [{ "id": "uuid", "ext": "mp3|ogg", "bitrate": 320, "path": "https://...", "created_at": "ISO" }]
}
```

## Admin endpoints

### `GET /api/admin/tracks`
- Query: `page`, `limit`, `q`
- Response: `{ items, total, page, limit }`

### `GET /api/admin/tracks/:id`
- Response: full track object

### `POST /api/admin/tracks`
- Content-Type: `multipart/form-data`
- Required fields: `title`, `album_id`, `duration`
- Optional fields: `subtitle`, `track_number`, `disc_number`, `language_code`, `lyrics_url`, `lyrics_snippet`, `is_explicit`, `copyright_text`, `label_id`, `hls_master_path`, `is_published`
- Files: `audio` (required), `video` (optional)
- Behavior:
  - Creates track with `is_published=false`
  - Processes audio and stores rows in `track_assets` as `audio_progressive`
  - Auto-links album owners in `track_artists`
  - Sets `is_published=true` when audio processing succeeds

### `PATCH /api/admin/tracks/:id`
- Content-Type: `multipart/form-data`
- Any writable fields from create
- `audio` replaces prior `audio_progressive` variants in `track_assets`

### `DELETE /api/admin/tracks/:id`
- Deletes track and dependent rows (`track_assets`, `track_artists`, etc. via FK)

### Track artist management
- `POST /api/admin/tracks/:id/artists` with `{ artist_id, role }`
- `PATCH /api/admin/tracks/:id/artists/:artistId` with `{ role }`
- `DELETE /api/admin/tracks/:id/artists/:artistId`

## User endpoints

### `GET /api/user/tracks`
- Lists published tracks only
- Query: `page`, `limit`, `q`

### `GET /api/user/tracks/:id`
- Returns one published track

### `POST /api/user/tracks`
- Auth required
- Only album owners can create
- Same media handling as admin

### `PATCH /api/user/tracks/:id`
- Auth required
- Only album owners can update

### `DELETE /api/user/tracks/:id`
- Auth required
- Only album owners can delete

### Track artist management (owner only)
- `POST /api/user/tracks/:id/artists`
- `PATCH /api/user/tracks/:id/artists/:artistId`
- `DELETE /api/user/tracks/:id/artists/:artistId`

## Notes

- Old `track_audios` references were migrated to `track_assets`.
- Provider-specific metadata should be written to `track_external_refs`, not `tracks`.
