# Playlists API

Base paths:
- Admin: `/api/admin/playlists`
- User: `/api/user/playlists`

## Schema alignment

- Core table: `playlists`
- Track membership/order: `playlist_tracks` (with `position`, `added_by`, `added_at`)
- External refs: `playlist_external_refs`

## Playlist object

```json
{
  "playlist_id": "uuid",
  "name": "string",
  "creator_id": "uuid|null",
  "is_public": true,
  "description": "string|null",
  "cover_url": "string|null",
  "language_code": "en|null",
  "likes_count": 0,
  "total_tracks": 0,
  "duration": 0,
  "created_at": "ISO",
  "updated_at": "ISO",
  "tracks": [
    { "track_id": "uuid", "title": "string", "duration": 215, "created_at": "ISO" }
  ]
}
```

## Admin endpoints

- `GET /api/admin/playlists`
- `GET /api/admin/playlists/:id`
- `POST /api/admin/playlists`
- `PATCH /api/admin/playlists/:id`
- `DELETE /api/admin/playlists/:id`

### Admin track membership
- `POST /api/admin/playlists/:id/tracks` body `{ track_id }`
- `DELETE /api/admin/playlists/:id/tracks/:trackId`

## User endpoints

- `GET /api/user/playlists` (public only)
- `GET /api/user/playlists/:id` (public only)
- `POST /api/user/playlists` (creator from auth user)
- `PATCH /api/user/playlists/:id` (owner only)
- `DELETE /api/user/playlists/:id` (owner only)

### User track membership (owner only)
- `POST /api/user/playlists/:id/tracks` body `{ track_id }`
- `DELETE /api/user/playlists/:id/tracks/:trackId`

### User writable playlist fields

`name`, `description`, `is_public`, `language_code`

## Notes

- Legacy `playlists.genres` is removed from schema and API.
- Track insertion now computes and stores next `position` in `playlist_tracks`.
