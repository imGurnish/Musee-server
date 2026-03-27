# Users API

Base paths:
- Admin: `/api/admin/users`
- User: `/api/user/users`

## Schema alignment

Current `users` table fields used by API:
- `user_id`, `email`, `name`, `user_type`, `subscription_type`, `plan_id`, `avatar_url`
- `followers_count`, `followings_count`, `settings`, `last_login_at`, `created_at`, `updated_at`

## Admin endpoints

- `GET /api/admin/users` → paginated list (`page`, `limit`, `q`)
- `GET /api/admin/users/:id` → single user
- `POST /api/admin/users` → create user + auth profile
- `PATCH /api/admin/users/:id` → update user
- `DELETE /api/admin/users/:id` → delete user

## User endpoints

- `GET /api/user/users` → public profiles (`user_id`, `name`, `avatar_url`)
- `GET /api/user/users/:id` → public profile summary
- `GET /api/user/users/me` → own full profile
- `PATCH /api/user/users/:id` → own profile update only
- `DELETE /api/user/users/:id` → own profile delete

### User writable fields

`name`, `settings`

## Notes

- Legacy `users.playlists` and `users.favorites` are removed from schema and API.
- Playlist membership is managed through `playlists` and `playlist_tracks` tables.
