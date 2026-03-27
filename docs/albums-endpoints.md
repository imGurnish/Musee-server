# Albums API

Base paths:
- Admin: `/api/admin/albums`
- User: `/api/user/albums`

## Schema alignment

- Core table: `albums`
- Artist links: `album_artists`
- Genre links: `album_genres`
- External refs: `album_external_refs`

## Album object

```json
{
  "album_id": "uuid",
  "title": "string",
  "subtitle": "string|null",
  "description": "string|null",
  "release_date": "YYYY-MM-DD|null",
  "release_year": 2026,
  "language_code": "en|null",
  "label_id": "uuid|null",
  "cover_url": "string",
  "copyright_text": "string|null",
  "is_published": false,
  "total_tracks": 0,
  "duration": 0,
  "likes_count": 0,
  "created_at": "ISO",
  "updated_at": "ISO",
  "genres": [],
  "artists": [{ "artist_id": "uuid", "role": "owner|editor|viewer", "name": "string|null", "avatar_url": "string|null" }]
}
```

## Admin endpoints

- `GET /api/admin/albums` → paginated list (`page`, `limit`, `q`)
- `GET /api/admin/albums/:id` → one album with artists and tracks
- `POST /api/admin/albums` → create album (requires `artist_id` to link owner)
- `PATCH /api/admin/albums/:id` → update album
- `DELETE /api/admin/albums/:id` → delete album

### Admin album artist routes
- `POST /api/admin/albums/:id/artists` body `{ artist_id, role }`
- `PATCH /api/admin/albums/:id/artists/:artistId` body `{ role }`
- `DELETE /api/admin/albums/:id/artists/:artistId`

## User endpoints

- `GET /api/user/albums` → published albums only
- `GET /api/user/albums/:id` → one published album with tracks
- `POST /api/user/albums` → artist-only create (creator linked as owner)
- `PATCH /api/user/albums/:id` → owner-only update
- `DELETE /api/user/albums/:id` → owner-only delete

### User writable fields

`title`, `subtitle`, `description`, `release_date`, `release_year`, `language_code`, `label_id`, `copyright_text`, `is_published`

### User album artist routes (owner-only)
- `POST /api/user/albums/:id/artists`
- `PATCH /api/user/albums/:id/artists/:artistId`
- `DELETE /api/user/albums/:id/artists/:artistId`

## Notes

- Legacy direct `albums.genres` column is removed; genres are normalized in `album_genres`.
- API currently returns `genres: []` for compatibility.
