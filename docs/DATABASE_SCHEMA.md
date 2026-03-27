# Musee Database Schema V2

**Last Updated:** March 23, 2026  
**Status:** Production  
**Target:** PostgreSQL / Supabase

---

## Table of Contents
1. [Core User & Auth](#core-user--auth)
2. [Artist Management](#artist-management)
3. [Music Content](#music-content)
4. [Social Features](#social-features)
5. [External Provider Integration](#external-provider-integration)
6. [Enums & Types](#enums--types)
7. [Indexes](#indexes)

---

## Core User & Auth

### `users`
Core user table, referenced by Supabase auth.users.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `user_id` | `uuid` | PK, FK→auth.users(id) | gen_random_uuid() |
| `email` | `text` | UNIQUE, NOT NULL, email format check | — |
| `name` | `text` | NOT NULL | — |
| `user_type` | `user_type` | ENUM | 'listener' |
| `subscription_type` | `subscription_type` | ENUM | 'free' |
| `plan_id` | `uuid` | FK→plans(plan_id) | NULL |
| `avatar_url` | `text` | — | default avatar |
| `followers_count` | `integer` | NOT NULL, ≥0 | 0 |
| `followings_count` | `integer` | NOT NULL, ≥0 | 0 |
| `settings` | `jsonb` | NOT NULL | {} |
| `last_login_at` | `timestamptz` | — | NULL |
| `created_at` | `timestamptz` | NOT NULL | now() |
| `updated_at` | `timestamptz` | NOT NULL, auto-update | now() |

**Indexes:** user_id, email, user_type, created_at DESC

---

### `regions`
Geographic regions for artist location tagging.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `region_id` | `uuid` | PK | gen_random_uuid() |
| `code` | `text` | UNIQUE, NOT NULL | — |
| `name` | `text` | UNIQUE, NOT NULL | — |
| `created_at` | `timestamptz` | NOT NULL | now() |

---

### `plans`
Subscription plans.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `plan_id` | `uuid` | PK | gen_random_uuid() |
| `name` | `text` | UNIQUE, NOT NULL | — |
| `description` | `text` | — | NULL |
| `monthly_cost` | `numeric(10,2)` | NOT NULL, ≥0 | 0.00 |
| `yearly_cost` | `numeric(10,2)` | NOT NULL, ≥0 | 0.00 |
| `created_at` | `timestamptz` | NOT NULL | now() |
| `updated_at` | `timestamptz` | NOT NULL, auto-update | now() |

---

## Artist Management

### `artists`
Artist profiles, extends users table.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `artist_id` | `uuid` | PK, FK→users(user_id) CASCADE | gen_random_uuid() |
| `bio` | `text` | — | NULL |
| `cover_url` | `text` | — | default artist cover |
| `debut_year` | `integer` | year ≥1900 and ≤current | NULL |
| `is_verified` | `boolean` | NOT NULL | false |
| `social_links` | `jsonb` | NOT NULL | {} |
| `monthly_listeners` | `integer` | NOT NULL, ≥0 | 0 |
| `region_id` | `uuid` | FK→regions(region_id) | NULL |
| `date_of_birth` | `date` | — | NULL |
| `created_at` | `timestamptz` | NOT NULL | now() |
| `updated_at` | `timestamptz` | NOT NULL, auto-update | now() |

**Triggers:**
- `trg_set_user_type_to_artist_v2`: Sets `users.user_type = 'artist'` on INSERT
- `trg_set_user_type_to_listener_v2`: Sets `users.user_type = 'listener'` on DELETE (if no other artist records)
- `trg_artists_touch_updated_at`: Auto-updates `updated_at` on UPDATE

**Indexes:** region_id

---

### `artist_genres`
many-to-many: artists ↔ genres

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `artist_id` | `uuid` | FK→artists(artist_id) CASCADE | — |
| `genre_id` | `uuid` | FK→genres(genre_id) CASCADE | — |
| `created_at` | `timestamptz` | NOT NULL | now() |
| **PK** | `(artist_id, genre_id)` | — | — |

---

### `genres`
Music genres / categories.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `genre_id` | `uuid` | PK | gen_random_uuid() |
| `slug` | `text` | UNIQUE, NOT NULL | — |
| `name` | `text` | UNIQUE, NOT NULL | — |
| `created_at` | `timestamptz` | NOT NULL | now() |

---

### `labels`
Record labels.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `label_id` | `uuid` | PK | gen_random_uuid() |
| `name` | `text` | UNIQUE, NOT NULL | — |
| `external_label_id` | `text` | — | NULL |
| `label_url` | `text` | — | NULL |
| `created_at` | `timestamptz` | NOT NULL | now() |
| `updated_at` | `timestamptz` | NOT NULL, auto-update | now() |

---

## Music Content

### `albums`
Album releases.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `album_id` | `uuid` | PK | gen_random_uuid() |
| `title` | `text` | NOT NULL | — |
| `subtitle` | `text` | — | NULL |
| `description` | `text` | — | NULL |
| `release_date` | `date` | — | NULL |
| `release_year` | `integer` | year ≥1900 and ≤current | NULL |
| `language_code` | `text` | FK→languages(language_code) | NULL |
| `label_id` | `uuid` | FK→labels(label_id) | NULL |
| `cover_url` | `text` | — | default album cover |
| `copyright_text` | `text` | — | NULL |
| `is_published` | `boolean` | NOT NULL | false |
| `total_tracks` | `integer` | NOT NULL, ≥0 | 0 |
| `duration` | `integer` | NOT NULL, ≥0 | 0 |
| `likes_count` | `bigint` | NOT NULL, ≥0 | 0 |
| `created_at` | `timestamptz` | NOT NULL | now() |
| `updated_at` | `timestamptz` | NOT NULL, auto-update | now() |

**Triggers:** `trg_albums_touch_updated_at`

**Indexes:** album_id

---

### `album_artists`
many-to-many: albums ↔ artists with roles.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `album_artist_id` | `uuid` | PK | gen_random_uuid() |
| `album_id` | `uuid` | FK→albums(album_id) CASCADE | — |
| `artist_id` | `uuid` | FK→artists(artist_id) CASCADE | — |
| `role` | `artist_role` | ENUM: owner, editor, viewer | 'viewer' |
| `sort_order` | `integer` | NOT NULL | 0 |
| `created_at` | `timestamptz` | NOT NULL | now() |
| **CONSTRAINT** | `(album_id, artist_id)` | UNIQUE | — |

**Indexes:** artist_id, role

---

### `album_genres`
many-to-many: albums ↔ genres

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `album_id` | `uuid` | FK→albums(album_id) CASCADE | — |
| `genre_id` | `uuid` | FK→genres(genre_id) CASCADE | — |
| `created_at` | `timestamptz` | NOT NULL | now() |
| **PK** | `(album_id, genre_id)` | — | — |

---

### `tracks`
Individual songs / tracks.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `track_id` | `uuid` | PK | gen_random_uuid() |
| `title` | `text` | NOT NULL | — |
| `subtitle` | `text` | — | NULL |
| `album_id` | `uuid` | FK→albums(album_id) | NULL |
| `track_number` | `integer` | >0 if not NULL | NULL |
| `disc_number` | `integer` | >0 if not NULL | NULL |
| `duration` | `integer` | NOT NULL, ≥0 | — |
| `language_code` | `text` | FK→languages(language_code) | NULL |
| `lyrics_url` | `text` | — | NULL |
| `lyrics_snippet` | `text` | — | NULL |
| `is_explicit` | `boolean` | NOT NULL | false |
| `is_published` | `boolean` | NOT NULL | false |
| `play_count` | `bigint` | NOT NULL, ≥0 | 0 |
| `likes_count` | `bigint` | NOT NULL, ≥0 | 0 |
| `popularity_score` | `double precision` | NOT NULL, ≥0 | 0.0 |
| `copyright_text` | `text` | — | NULL |
| `label_id` | `uuid` | FK→labels(label_id) | NULL |
| `video_url` | `text` | — | NULL |
| `hls_master_path` | `text` | — | NULL |
| `created_at` | `timestamptz` | NOT NULL | now() |
| `updated_at` | `timestamptz` | NOT NULL, auto-update | now() |

**Triggers:** `trg_tracks_touch_updated_at`

**Indexes:** album_id, language_code, published (is_published, created_at DESC)

---

### `track_artists`
many-to-many: tracks ↔ artists with roles.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `track_artist_id` | `uuid` | PK | gen_random_uuid() |
| `track_id` | `uuid` | FK→tracks(track_id) CASCADE | — |
| `artist_id` | `uuid` | FK→artists(artist_id) CASCADE | — |
| `role` | `artist_role` | ENUM: owner, editor, viewer | 'viewer' |
| `sort_order` | `integer` | NOT NULL | 0 |
| `created_at` | `timestamptz` | NOT NULL | now() |
| **CONSTRAINT** | `(track_id, artist_id)` | UNIQUE | — |

**Indexes:** artist_id, role

---

### `track_genres`
many-to-many: tracks ↔ genres

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `track_id` | `uuid` | FK→tracks(track_id) CASCADE | — |
| `genre_id` | `uuid` | FK→genres(genre_id) CASCADE | — |
| `created_at` | `timestamptz` | NOT NULL | now() |
| **PK** | `(track_id, genre_id)` | — | — |

---

### `track_assets`
Audio/video files associated with tracks (progressive, HLS, video).

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `track_asset_id` | `uuid` | PK | gen_random_uuid() |
| `track_id` | `uuid` | FK→tracks(track_id) CASCADE | — |
| `asset_type` | `text` | ENUM: audio_progressive, audio_hls_master, audio_hls_variant, audio_hls_segment, video | — |
| `codec` | `text` | — | NULL |
| `ext` | `text` | — | NULL |
| `bitrate_kbps` | `integer` | >0 if not NULL | NULL |
| `sample_rate_hz` | `integer` | — | NULL |
| `channels` | `smallint` | — | NULL |
| `file_path` | `text` | NOT NULL | — |
| `file_size_bytes` | `bigint` | — | NULL |
| `duration_ms` | `integer` | — | NULL |
| `is_default` | `boolean` | NOT NULL | false |
| `created_at` | `timestamptz` | NOT NULL | now() |

**Indexes:** track_id, asset_type, bitrate_kbps

---

### `track_credits`
Credits for tracks (singers, composers, producers, etc.).

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `track_credit_id` | `uuid` | PK | gen_random_uuid() |
| `track_id` | `uuid` | FK→tracks(track_id) CASCADE | — |
| `artist_id` | `uuid` | FK→artists(artist_id) SET NULL | NULL |
| `credit_type` | `text` | ENUM: primary, featured, singer, composer, lyricist, actor, producer, other | — |
| `display_name` | `text` | NOT NULL | — |
| `external_artist_id` | `text` | — | NULL |
| `sort_order` | `integer` | NOT NULL | 0 |
| `created_at` | `timestamptz` | NOT NULL | now() |
| **CONSTRAINT** | `(track_id, credit_type, display_name)` | UNIQUE | — |

---

### `languages`
Language codes and names.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `language_code` | `text` | PK | — |
| `name` | `text` | NOT NULL | — |
| `created_at` | `timestamptz` | NOT NULL | now() |

---

## Social Features

### `playlists`
User-created or curated playlists.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `playlist_id` | `uuid` | PK | gen_random_uuid() |
| `name` | `text` | NOT NULL | — |
| `description` | `text` | — | NULL |
| `creator_id` | `uuid` | FK→users(user_id) CASCADE | NULL |
| `is_public` | `boolean` | NOT NULL | true |
| `cover_url` | `text` | — | default playlist cover |
| `language_code` | `text` | FK→languages(language_code) | NULL |
| `likes_count` | `bigint` | NOT NULL, ≥0 | 0 |
| `total_tracks` | `integer` | NOT NULL, ≥0 | 0 |
| `duration` | `integer` | NOT NULL, ≥0 | 0 |
| `created_at` | `timestamptz` | NOT NULL | now() |
| `updated_at` | `timestamptz` | NOT NULL, auto-update | now() |

**Triggers:** `trg_playlists_touch_updated_at`

---

### `playlist_tracks`
Ordered tracks in playlists.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `playlist_track_id` | `uuid` | PK | gen_random_uuid() |
| `playlist_id` | `uuid` | FK→playlists(playlist_id) CASCADE | — |
| `track_id` | `uuid` | FK→tracks(track_id) CASCADE | — |
| `position` | `integer` | NOT NULL, >0 | — |
| `added_by` | `uuid` | FK→users(user_id) SET NULL | NULL |
| `added_at` | `timestamptz` | NOT NULL | now() |
| **CONSTRAINT** | `(playlist_id, track_id)` | UNIQUE | — |
| **CONSTRAINT** | `(playlist_id, position)` | UNIQUE | — |

**Indexes:** playlist_id, position

---

### `followers`
User follow relationships.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `follower_id` | `uuid` | FK→users(user_id) CASCADE | — |
| `following_id` | `uuid` | FK→users(user_id) CASCADE | — |
| `created_at` | `timestamptz` | NOT NULL | now() |
| **PK** | `(follower_id, following_id)` | — | — |
| **CONSTRAINT** | follower_id ≠ following_id | — | — |

**Indexes:** following_id

---

## External Provider Integration

### `external_providers`
Supported external music providers (JioSaavn, Spotify, YouTube Music).

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `provider_id` | `smallserial` | PK | auto |
| `code` | `text` | UNIQUE, NOT NULL | — |
| `name` | `text` | NOT NULL | — |
| `base_url` | `text` | — | NULL |
| `created_at` | `timestamptz` | NOT NULL | now() |

**Seeded providers:**
- (1, 'jiosaavn', 'JioSaavn', 'https://www.jiosaavn.com')
- (2, 'spotify', 'Spotify', 'https://open.spotify.com')
- (3, 'youtube_music', 'YouTube Music', 'https://music.youtube.com')

---

### `artist_external_refs`
External provider IDs and metadata for artists.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `artist_external_ref_id` | `uuid` | PK | gen_random_uuid() |
| `artist_id` | `uuid` | FK→artists(artist_id) CASCADE | — |
| `provider_id` | `smallint` | FK→external_providers(provider_id) CASCADE | — |
| `external_id` | `text` | NOT NULL | — |
| `external_url` | `text` | — | NULL |
| `image_url` | `text` | — | NULL |
| `raw_payload` | `jsonb` | — | NULL |
| `created_at` | `timestamptz` | NOT NULL | now() |
| `updated_at` | `timestamptz` | NOT NULL, auto-update | now() |
| **CONSTRAINT** | `(provider_id, external_id)` | UNIQUE | — |
| **CONSTRAINT** | `(artist_id, provider_id)` | UNIQUE | — |

**Indexes:** provider_id, external_id

---

### `album_external_refs`
External provider IDs and metadata for albums.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `album_external_ref_id` | `uuid` | PK | gen_random_uuid() |
| `album_id` | `uuid` | FK→albums(album_id) CASCADE | — |
| `provider_id` | `smallint` | FK→external_providers(provider_id) CASCADE | — |
| `external_id` | `text` | NOT NULL | — |
| `external_url` | `text` | — | NULL |
| `image_url` | `text` | — | NULL |
| `raw_payload` | `jsonb` | — | NULL |
| `created_at` | `timestamptz` | NOT NULL | now() |
| `updated_at` | `timestamptz` | NOT NULL, auto-update | now() |
| **CONSTRAINT** | `(provider_id, external_id)` | UNIQUE | — |
| **CONSTRAINT** | `(album_id, provider_id)` | UNIQUE | — |

**Indexes:** provider_id, external_id

---

### `track_external_refs`
JioSaavn and other provider metadata for tracks.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `track_external_ref_id` | `uuid` | PK | gen_random_uuid() |
| `track_id` | `uuid` | FK→tracks(track_id) CASCADE | — |
| `provider_id` | `smallint` | FK→external_providers(provider_id) CASCADE | — |
| `external_id` | `text` | NOT NULL | — |
| `external_url` | `text` | — | NULL |
| `external_album_id` | `text` | — | NULL |
| `image_url` | `text` | — | NULL |
| `language` | `text` | — | NULL |
| `release_date` | `date` | — | NULL |
| `play_count_external` | `bigint` | — | NULL |
| `has_lyrics` | `boolean` | — | NULL |
| `is_drm` | `boolean` | — | NULL |
| `is_dolby_content` | `boolean` | — | NULL |
| `has_320kbps` | `boolean` | — | NULL |
| `encrypted_media_url` | `text` | — | NULL |
| `encrypted_drm_media_url` | `text` | — | NULL |
| `encrypted_media_path` | `text` | — | NULL |
| `media_preview_url` | `text` | — | NULL |
| `rights` | `jsonb` | — | NULL |
| `raw_payload` | `jsonb` | — | NULL |
| `created_at` | `timestamptz` | NOT NULL | now() |
| `updated_at` | `timestamptz` | NOT NULL, auto-update | now() |
| **CONSTRAINT** | `(provider_id, external_id)` | UNIQUE | — |
| **CONSTRAINT** | `(track_id, provider_id)` | UNIQUE | — |

**Indexes:** provider_id, track_id; provider_id, external_id

---

### `external_track_credits`
Credits from external providers (JioSaavn) before internal normalization.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `external_track_credit_id` | `uuid` | PK | gen_random_uuid() |
| `track_external_ref_id` | `uuid` | FK→track_external_refs(track_external_ref_id) CASCADE | — |
| `credit_type` | `text` | ENUM: primary, featured, singer, composer, lyricist, actor, producer, other | — |
| `external_artist_id` | `text` | — | NULL |
| `display_name` | `text` | NOT NULL | — |
| `sort_order` | `integer` | NOT NULL | 0 |
| `created_at` | `timestamptz` | NOT NULL | now() |
| **CONSTRAINT** | `(track_external_ref_id, credit_type, display_name)` | UNIQUE | — |

---

### `playlist_external_refs`
External provider IDs and metadata for playlists.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `playlist_external_ref_id` | `uuid` | PK | gen_random_uuid() |
| `playlist_id` | `uuid` | FK→playlists(playlist_id) CASCADE | — |
| `provider_id` | `smallint` | FK→external_providers(provider_id) CASCADE | — |
| `external_id` | `text` | NOT NULL | — |
| `external_url` | `text` | — | NULL |
| `image_url` | `text` | — | NULL |
| `raw_payload` | `jsonb` | — | NULL |
| `created_at` | `timestamptz` | NOT NULL | now() |
| `updated_at` | `timestamptz` | NOT NULL, auto-update | now() |
| **CONSTRAINT** | `(provider_id, external_id)` | UNIQUE | — |
| **CONSTRAINT** | `(playlist_id, provider_id)` | UNIQUE | — |

**Indexes:** provider_id, external_id

---

## Enums & Types

### `artist_role`
```sql
ENUM ('owner', 'editor', 'viewer')
```
Used in `album_artists` and `track_artists` for permission levels.

### `user_type`
```sql
ENUM ('listener', 'artist', 'admin')
```
User account type.

### `subscription_type`
```sql
ENUM ('free', 'premium', 'pro', 'artist')
```
Subscription tier.

---

## Indexes

### Performance Indexes
| Table | Index | Columns | Purpose |
|-------|-------|---------|---------|
| artists | idx_artists_region | region_id | Filter by region |
| album_artists | idx_album_artists_artist | artist_id, role | Permission checks |
| track_artists | idx_track_artists_artist | artist_id, role | Permission checks |
| tracks | idx_tracks_album | album_id | Album track listing |
| tracks | idx_tracks_language | language_code | Language filtering |
| tracks | idx_tracks_published | is_published, created_at DESC | Published tracks feed |
| track_assets | idx_track_assets_track_type | track_id, asset_type, bitrate_kbps | Asset variant selection |
| playlist_tracks | idx_playlist_tracks_playlist_position | playlist_id, position | Ordering queries |
| followers | idx_followers_following | following_id | Following counts |
| track_external_refs | idx_track_external_provider_track | provider_id, track_id | Dedupe lookups |
| track_external_refs | idx_track_external_provider_external | provider_id, external_id | Reverse lookup |
| album_external_refs | idx_album_external_provider_external | provider_id, external_id | Reverse lookup |
| artist_external_refs | idx_artist_external_provider_external | provider_id, external_id | Reverse lookup |
| users | idx_users_email | email | Auth lookups |
| users | idx_users_user_type | user_type | Role filtering |
| users | idx_users_created_at | created_at DESC | User list pagination |
| regions | idx_regions_code | code | Region lookup |

---

## Key Design Patterns

### Many-to-Many Relationships
- **album_artists**: Links artists to albums with role-based permissions
- **track_artists**: Links artists to tracks with role-based permissions
- **track_genres**: Links genres to tracks
- **album_genres**: Links genres to albums
- **artist_genres**: Links genres to artists
- **playlist_tracks**: Ordered track list with position uniqueness

All junction tables use **composite primary keys** or **unique constraints** to prevent duplicates.

### External Provider Strategy
- **Separate `*_external_refs` tables**: Keeps provider-specific data isolated from core tables
- **Single provider per entity**: `UNIQUE (entity_id, provider_id)` prevents multi-provider entries per entity
- **Raw payload storage**: `raw_payload JSONB` preserves full JioSaavn/Spotify responses
- **Dedupe by external ID**: `UNIQUE (provider_id, external_id)` enables fast duplicate detection

### Publication & Visibility
- **is_published flag**: Controls visibility in RLS policies
- **Role-based access**: Tracks/albums owned by artists can be edited by `owner`/`editor` roles
- **Public playlists**: Visibility determined by `is_public` flag

### Audit Trail
- **created_at / updated_at**: All tables track creation and modification times
- **Triggers**: Auto-generation of `updated_at` via `touch_updated_at()` function

---

## Row Level Security (RLS)

All tables have RLS enabled with policies for:

### Public Read
- `genres`, `labels`, `languages`, `external_providers`
- All published content (`albums.is_published = true`, `tracks.is_published = true`)
- Public playlists (`playlists.is_public = true`)
- All user relationships and social follows

### Admin Write
- `genres`, `labels`, `external_providers` updates/inserts

### Owner-Based Write
- Artists manage their own `artist_genres`
- Artists with `owner`/`editor` roles manage album content
- Artists with `owner`/`editor` roles manage track content
- Users create/edit their own playlists

---

## Database Constraints

### Foreign Key Cascade Rules
- **ON UPDATE CASCADE**: FK values updated in parent cascade to children
- **ON DELETE CASCADE**: Parent deletion removes all dependent rows
- **ON DELETE SET NULL**: Parent deletion nulls the FK in children (for optional relationships)

### Check Constraints
- `artists.debut_year BETWEEN 1900 and EXTRACT(YEAR FROM now())`
- `artists.monthly_listeners >= 0`
- `albums.total_tracks >= 0`, `albums.duration >= 0`, `albums.release_year BETWEEN 1900 and EXTRACT(YEAR FROM now())`
- `tracks.duration >= 0`, `tracks.track_number > 0`, `tracks.disc_number > 0`, `tracks.play_count >= 0`, `tracks.likes_count >= 0`
- `playlist_tracks.position > 0`
- `followers.follower_id <> following_id` (no self-follows)
- All `*_count bigint >= 0`

---

## Triggers

| Trigger | Table | Timing | Function |
|---------|-------|--------|----------|
| `trg_artists_touch_updated_at` | artists | BEFORE UPDATE | Auto-update `updated_at` |
| `trg_set_user_type_to_artist_v2` | artists | AFTER INSERT | Set `users.user_type = 'artist'` |
| `trg_set_user_type_to_listener_v2` | artists | AFTER DELETE | Revert `users.user_type = 'listener'` |
| `trg_albums_touch_updated_at` | albums | BEFORE UPDATE | Auto-update `updated_at` |
| `trg_tracks_touch_updated_at` | tracks | BEFORE UPDATE | Auto-update `updated_at` |
| `trg_playlists_touch_updated_at` | playlists | BEFORE UPDATE | Auto-update `updated_at` |
| `trg_*_external_refs_touch_updated_at` | all external_refs | BEFORE UPDATE | Auto-update `updated_at` |
| `trg_labels_touch_updated_at` | labels | BEFORE UPDATE | Auto-update `updated_at` |
| `trg_users_touch_updated_at` | users | BEFORE UPDATE | Auto-update `updated_at` |
| `trg_plans_touch_updated_at` | plans | BEFORE UPDATE | Auto-update `updated_at` |

---

## Example Queries

### Find all tracks by an artist
```sql
SELECT t.* FROM tracks t
INNER JOIN track_artists ta ON ta.track_id = t.track_id
WHERE ta.artist_id = $1
ORDER BY ta.sort_order;
```

### Check if external track exists (dedupe)
```sql
SELECT track_id FROM track_external_refs
WHERE provider_id = (SELECT provider_id FROM external_providers WHERE code = 'jiosaavn')
  AND external_id = $1;
```

### Get published album with all artists
```sql
SELECT a.*, json_agg(json_build_object(
  'artist_id', ar.artist_id,
  'display_name', u.name,
  'role', ar.role
  ORDER BY ar.sort_order
)) as artists
FROM albums a
LEFT JOIN album_artists ar ON ar.album_id = a.album_id
LEFT JOIN users u ON u.user_id = ar.artist_id
WHERE a.album_id = $1 AND a.is_published = true
GROUP BY a.album_id;
```

### Get user's private + public playlists
```sql
SELECT * FROM playlists
WHERE creator_id = $1
  OR is_public = true
ORDER BY created_at DESC;
```

---

## Notes

- All tables use `gen_random_uuid()` for surrogate keys except `external_providers.provider_id` (smallserial for space-efficiency)
- Timestamps are `timestamptz` (timezone-aware) for proper distributed system handling
- RLS is enabled on all music-domain tables; queries bypass RLS when executed as service role
- External refs tables store raw JSON payloads for audit and schema evolution
- Artist ↔ User relationship is 1:1; artists.artist_id is a direct FK to users.user_id
