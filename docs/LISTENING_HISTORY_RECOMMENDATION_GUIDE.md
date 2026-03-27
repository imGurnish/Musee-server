# Listening History & Content-Based Recommendation System

## Overview
This schema enables a **production-grade content-based recommendation system** by tracking user listening behavior and storing content features for similarity matching. It supports recommendations for tracks, albums, artists, and playlists with built-in randomness to avoid filter bubbles.

## Table Architecture

### Core Tables

#### 1. **user_track_listening_history**
Every track play logged with detailed engagement metrics.

**Key Columns:**
- `user_id`, `track_id` - Core identifiers
- `time_listened_seconds` - How long user actually listened (KEY for quality signal)
- `completion_percentage` - % of track heard (0-100). High % = strong quality signal
- `was_skipped` - Whether user skipped (negative signal)
- `listening_context` - Context of play ('playlist', 'album', 'search', 'recommendation', 'radio')
- `context_id` - Optional reference to playlist/album

**Why This Design:**
- Completion % is your best signal for "user liked this"
- Skips indicate rejection
- Context helps understand recommendation chains
- Supports A/B testing different recommendation sources

#### 2. **user_track_preferences**
Explicit user feedback (likes/dislikes).

**Key Columns:**
- `preference` - -1 (dislike), 0 (neutral), 1 (like)
- `mood` - Optional mood tags for the track

**Combined Signal:** Use both implicit (listening history) + explicit (preferences) for best recommendations.

#### 3. **track_content_features**
Content features for similarity matching - the core of content-based recommendations.

**Key Columns:**
- `genres` - Denormalized from tracks table
- `mood` - 'happy', 'sad', 'energetic', 'melancholic', 'party', etc.
- `energy_level`, `danceability`, `acousticness` - Audio features (0.0-1.0)
- `embedding` - ML embeddings for semantic similarity (JSON array)
- `similar_track_ids` - Cache of similar track IDs (updated periodically)

**How to Populate:**
1. **Initial:** Extract genres/mood/language from tracks table
2. **ML Pipeline:** Calculate energy, danceability, etc. via ML model (Spotify Audio Features API or equivalent)
3. **Embeddings:** Store ML model embeddings for semantic similarity searches

#### 4. **user_artist_listening_history** & **user_album_listening_history**
Aggregate stats at artist/album level for faster queries.

**Key Columns:**
- `play_count` - Total plays
- `total_time_listened_seconds` - Total listen time
- `unique_tracks_played` - How many different tracks from artist/album
- `last_played_at` - Recency signal

#### 5. **user_onboarding_preferences**
Cold-start recommendations - initialized during user onboarding.

**Key Columns:**
- `preferred_language`, `preferred_region_id` - Localization
- `favorite_genres`, `favorite_moods` - User tells us what they like
- `randomness_percentage` - % of recommendations to randomize (default 15%)

**Why Randomness?** Prevents filter bubbles. Even if user likes only rock, occasionally recommend jazz to expand taste.

#### 6. **user_recommendations_cache**
Pre-computed recommendations, refreshed periodically (every 6-24 hours).

**Key Columns:**
- `recommendation_type` - 'similar_to_liked', 'discovery', 'trending', 'artist_top_tracks', 'mood_based'
- `recommended_track_ids` - Array of UUIDs in score order
- `reasons` - Why recommended: ['liked_artist', 'similar_genre', 'trending', 'high_completion_in_genre']
- `expires_at` - When to refresh this cache

**Cache Strategy:**
- Generate fresh recommendations on user login
- Serve from cache for 6-24 hours
- Refresh when user adds preference/plays significantly

#### 7. **user_genre_affinity** & **user_mood_affinity**
Calculated affinity scores (-1.0 to 1.0) for each genre/mood.

**Calculation Logic:**
```
affinity_score = (likes - dislikes) / total_tracks_in_genre
  + (total_listen_time_seconds / avg_duration) * 0.1
  + (completion_percentage - 50%) / 100 * 0.05
```

Use these for personalized scoring.

---

## Recommendation Algorithms

### Algorithm 1: Content-Based Similarity
```sql
-- Find tracks similar to user's liked tracks
SELECT similar_track_ids[1:10] 
FROM track_content_features
WHERE track_id IN (
  SELECT track_id FROM user_track_preferences 
  WHERE user_id = $1 AND preference = 1
)
```

### Algorithm 2: User Profile Matching
Match user's affinity profile against track content:
```sql
-- Tracks with genres the user likes
SELECT t.id 
FROM tracks t
CROSS JOIN user_genre_affinity uga
WHERE uga.user_id = $1 
  AND t.genres && ARRAY[uga.genre]
  AND uga.affinity_score > 0.3
ORDER BY uga.affinity_score DESC
LIMIT 50
```

### Algorithm 3: Collaborative + Content
1. Find users with similar listening history (collaborative)
2. Recommend what those users like but current user hasn't heard (content-based filtering)

### Algorithm 4: Trending in User's Taste
```sql
-- What's trending in user's favorite genres?
SELECT t.track_id, COUNT(*) as popularity
FROM user_track_listening_history utlh
JOIN track_content_features tcf ON utlh.track_id = tcf.track_id
JOIN user_genre_affinity uga ON tcf.genres && ARRAY[uga.genre]
WHERE uga.user_id = $1 
  AND uga.affinity_score > 0.4
  AND utlh.played_at > NOW() - INTERVAL '7 days'
  AND utlh.completion_percentage > 70
GROUP BY t.track_id
ORDER BY popularity DESC
```

### Algorithm 5: Randomness Injection
```sql
-- Mix recommendations with random tracks (respect onboarding%)
SELECT 
  CASE 
    WHEN RANDOM() < (oop.randomness_percentage / 100.0)
      THEN (SELECT id FROM tracks ORDER BY random() LIMIT 1)
    ELSE recommended_track_id
  END as track_id
FROM user_recommendations_cache urc
JOIN user_onboarding_preferences oop ON urc.user_id = oop.user_id
WHERE urc.user_id = $1
LIMIT 50
```

---

## Implementation Steps

### Phase 1: Core Logging (Week 1)
1. Deploy migration 002
2. Add logging to track play endpoint:
   ```javascript
   // src/controllers/tracksController.js
   app.post('/api/tracks/:id/play', async (req, res) => {
     const { timeListened, completionPercentage, context } = req.body;
     
     // Log to user_track_listening_history
     await db.query(`
       INSERT INTO user_track_listening_history 
       (user_id, track_id, time_listened_seconds, completion_percentage, listening_context)
       VALUES ($1, $2, $3, $4, $5)
     `, [userId, trackId, timeListened, completionPercentage, context]);
   });
   ```
3. Add preference endpoints:
   ```javascript
   app.post('/api/tracks/:id/like', ...)
   app.post('/api/tracks/:id/dislike', ...)
   ```

### Phase 2: Content Features (Week 2)
1. Populate `track_content_features` from existing `tracks` table:
   ```sql
   INSERT INTO track_content_features (track_id, genres, language, year, popularity_score)
   SELECT 
     track_id, 
     genres, 
     language, 
     year,
     popularity_score
   FROM tracks
   ```
2. Set up ML pipeline to calculate audio features (or use Spotify API if available)

### Phase 3: Affinity Calculation (Week 2)
1. Create daily batch job to calculate/update `user_genre_affinity` and `user_mood_affinity`
2. Trigger on user preference changes

### Phase 4: Recommendation Cache (Week 3)
1. Build recommendation engine (see algorithms above)
2. Create cache refresh job (hourly/daily)
3. Serve from `user_recommendations_cache` in recommendation endpoints

### Phase 5: Live Recommendations (Week 4)
1. Implement recommendation endpoints
2. Add to frontend discovery UI
3. A/B test different algorithms

---

## Key Queries for Common Operations

### Get User's Top Genres
```sql
SELECT genre, affinity_score 
FROM user_genre_affinity 
WHERE user_id = $1 
ORDER BY affinity_score DESC 
LIMIT 5;
```

### Get Recently Played Tracks
```sql
SELECT * FROM v_user_recent_plays 
WHERE user_id = $1 
LIMIT 20;
```

### Get Liked Tracks with Features
```sql
SELECT * FROM v_user_liked_tracks_with_features 
WHERE user_id = $1 
LIMIT 50;
```

### Find Similar Tracks to a Liked Track
```sql
SELECT similar_track_ids[1:10] 
FROM track_content_features 
WHERE track_id = $1;
```

### Find Recommended Artists
```sql
SELECT artist_id, play_count 
FROM v_user_top_artists 
WHERE user_id = $1 
ORDER BY rank 
LIMIT 10;
```

### Cache Refresh Trigger
```sql
UPDATE user_recommendations_cache 
SET expires_at = NOW() 
WHERE user_id = $1 
  AND expires_at < NOW();
```

---

## Performance Optimization

### Indexes
All critical query paths have indexes:
- `idx_user_track_listening_user_played` - Recent plays query
- `idx_track_features_genres` - Genre-based recommendations (GIN)
- `idx_genre_affinity_score` - Top genres for user
- `idx_rec_cache_expires` - Cache expiration cleanup

### Materialized Views
Consider materializing frequently used views:
```sql
CREATE MATERIALIZED VIEW mv_user_top_genres AS
SELECT user_id, genre, affinity_score 
FROM user_genre_affinity 
WHERE affinity_score > 0.2
ORDER BY user_id, affinity_score DESC;

CREATE INDEX idx_mv_user_top_genres_user ON mv_user_top_genres(user_id);

-- Refresh daily
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_user_top_genres;
```

### Data Retention
- Keep `user_track_listening_history` for 2+ years (needed for trends)
- Archive old listening history to separate table if needed
- Aggregate to daily/weekly summaries for long-term analysis

---

## Monitoring & Metrics

Track these to monitor recommendation quality:

1. **Engagement Metrics**
   - Click-through rate (% of recommendations clicked)
   - Completion % after recommendation click
   - Skip rate after recommendation

2. **Diversity Metrics**
   - % new artists recommended vs. user's top artists
   - % of recommendations from onboarded genres vs. discovered

3. **System Metrics**
   - Cache hit rate (serve from cache vs. compute)
   - Recommendation compute time
   - Data freshness (how old is listening history?)

---

## Future Enhancements

1. **Mood Detection** - Use audio analysis or lyrics to auto-tag moods
2. **Time-of-Day Recommendations** - Different recommendations for morning/evening
3. **Collaborative Filtering** - User-user similarity for "users like you" features
4. **Language Model Integration** - Use embeddings from large ML models for semantic search
5. **Real-Time Updates** - Update recommendation cache in real-time instead of batch
6. **A/B Testing Framework** - Test algorithm variants against real users
7. **Fairness Metrics** - Ensure emerging artists aren't buried by popular ones

---

## Rollback & Troubleshooting

### If Recommendations are Poor
1. Check `user_genre_affinity` scores - ensure completion % > 70% is being used
2. Verify `track_content_features.genres` are populated correctly
3. Check randomness injection - might be too high
4. Review listening context - some contexts might have poor signal (e.g., device speaker)

### Clear User Cache (for Testing)
```sql
DELETE FROM user_recommendations_cache WHERE user_id = $1;
```

### Recalculate User Profile
```sql
DELETE FROM user_genre_affinity WHERE user_id = $1;
DELETE FROM user_mood_affinity WHERE user_id = $1;
-- Run affinity calculation job
```
