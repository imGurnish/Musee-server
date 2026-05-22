# Dashboard endpoints (User)

This document describes the user-facing Dashboard endpoints. `made-for-you` and `trending` return mixed discovery feeds, while `albums-for-you` returns albums only. In future we will replace the placeholder logic with more personalized recommendation and trending signals.

Base path: `/api/user/dashboard` (requires authentication — include `Authorization: Bearer <JWT>`)

## Endpoints

### GET /api/user/dashboard/made-for-you

- Description: Mixed "Made for you" feed. For now it returns published albums, tracks, and playlists with pagination.
- Query parameters:
  - `limit` (integer, default 20, max 100)
  - `page` (integer, zero-based, default 0)
- Response: 200

```json
{
  "items": [
    {
      "type": "album",
      "album_id": "uuid",
      "title": "string",
      "cover_url": "https://...",
      "duration": 1234,
      "created_at": "ISO",
      "artists": [ { "artist_id": "uuid", "name": "string", "avatar_url": "https://..." } ]
    }
  ],
  "total": 123,
  "page": 0,
  "limit": 20
}
```

Notes:
- Currently implemented as a mixed discovery feed that combines albums, tracks, and playlists.
- Future: replace with personalized recommendations (followed artists, listening history, genre affinity).

### GET /api/user/dashboard/albums-for-you

- Description: Albums-only feed for the dashboard album section. Returns only albums with more than one song.
- Query parameters:
  - `limit` (integer, default 20, max 100)
  - `page` (integer, zero-based, default 0)
- Response: 200

```json
{
  "items": [
    {
      "type": "album",
      "album_id": "uuid",
      "title": "string",
      "cover_url": "https://...",
      "total_tracks": 8,
      "duration": 1234,
      "created_at": "ISO",
      "artists": [ { "artist_id": "uuid", "name": "string", "avatar_url": "https://..." } ]
    }
  ],
  "total": 123,
  "page": 0,
  "limit": 20
}
```

Notes:
- This endpoint is the one the album carousel/card section should use.
- It reuses the authenticated user language preferences but intentionally excludes single-track releases.

### GET /api/user/dashboard/trending

- Description: Mixed "Trending" feed. Returns published albums, tracks, and playlists.
- Query parameters: same as Made For You
- Response: same shape as Made For You

Notes:
- Current implementation mixes trending albums, tracks, and playlists; later this will be replaced by logic that sorts by play_count / likes / recent growth signals.

## Auth and access

- These endpoints are available under the authenticated user router (`/api/user`) and require a valid Supabase JWT in the `Authorization` header.
- Example header:

```
Authorization: Bearer <access_token>
```

## Implementation notes for backend developers

- Controller: `src/controllers/user/dashboardController.js` implements the mixed feeds plus `/albums-for-you`, which delegates to `listAlbumsUser` in `src/models/albumModel.js`.
- Routes: `src/routes/user/dashboardRoutes.js` mounts `/made-for-you`, `/albums-for-you`, and `/trending` and is imported in `src/routes/userRoutes.js` as `/dashboard`.

## Frontend UX notes

- Present both feeds as horizontally-scrollable carousels or vertical lists using the returned `items`.
- Page navigation is zero-based (`page=0` for first page). Use `limit` to adjust page size.
- When real recommendations are enabled, expect the results to change shape slightly (optional metadata like recommendation_reason or trending_score could be added).
