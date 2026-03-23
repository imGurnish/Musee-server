# Artists API

Base paths:
- Admin: `/api/admin/artists`
- User: `/api/user/artists`

## Schema alignment

- Core table: `artists` (1:1 with `users` via `artist_id=user_id`)
- Genre links: `artist_genres`
- External refs: `artist_external_refs`

## Artist object

```json
{
  "artist_id": "uuid",
  "bio": "string|null",
  "cover_url": "string|null",
  "debut_year": 2020,
  "is_verified": false,
  "social_links": {},
  "monthly_listeners": 0,
  "region_id": "uuid|null",
  "date_of_birth": "YYYY-MM-DD|null",
  "created_at": "ISO",
  "updated_at": "ISO",
  "genres": [],
  "users": {
    "user_id": "uuid",
    "name": "string",
    "email": "string",
    "avatar_url": "string|null",
    "user_type": "listener|artist|admin"
  }
}
```

## Admin endpoints

- `GET /api/admin/artists` → paginated list (`page`, `limit`, `q`)
- `GET /api/admin/artists/:id` → one artist
- `POST /api/admin/artists` → create artist
  - supports existing `artist_id` OR user creation (`name/email/password`)
- `PATCH /api/admin/artists/:id` → update artist
- `DELETE /api/admin/artists/:id` → delete artist

### Admin related lists
- `GET /api/admin/artists/:id/tracks`
- `GET /api/admin/artists/:id/albums`

## User endpoints

- `GET /api/user/artists`
- `GET /api/user/artists/:id`
- `POST /api/user/artists` → create own artist profile
- `PATCH /api/user/artists/:id` → update own profile only
- `DELETE /api/user/artists/:id` → delete own profile only
- `GET /api/user/artists/:id/tracks`
- `GET /api/user/artists/:id/albums`

### User writable fields

`bio`, `cover_url`, `social_links`, `region_id`, `date_of_birth`, `debut_year`

## Notes

- Legacy direct `artists.genres` array column is removed; genres are normalized in `artist_genres`.
- API currently returns `genres: []` for compatibility.
