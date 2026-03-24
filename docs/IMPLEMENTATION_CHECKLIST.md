# Listening History Implementation Checklist

## Overview
This guide tracks all necessary steps to deploy the listening history & recommendation system to production.

**Timeline:** 4 weeks (assuming ~20 hours/week development)
**Status:** Ready to implement

---

## Phase 1: Database & Core Setup (Week 1)

### Database
- [ ] Run migration `002_listening_history_and_recommendations.sql` in Supabase
  - Creates 10 new tables + 5 views
  - All indexes pre-configured
  - Expected time: 2-3 minutes
- [ ] Verify tables created:
  ```sql
  SELECT * FROM information_schema.tables 
  WHERE table_name LIKE 'user_%' OR table_name LIKE 'track_content%';
  ```
- [ ] Test views are working:
  ```sql
  SELECT * FROM v_user_recent_plays LIMIT 1;
  SELECT * FROM v_user_liked_tracks_with_features LIMIT 1;
  ```

### Backend Setup
- [ ] Copy `listeningHistoryController.js` to `src/controllers/`
- [ ] Copy `listeningHistoryRoutes.js` to `src/routes/`
- [ ] Register routes in `src/index.js`:
  ```javascript
  const listeningRoutes = require('./routes/listeningHistoryRoutes');
  app.use('/api/listening', listeningRoutes);
  app.use('/api/recommendations', listeningRoutes);
  ```
- [ ] Update `src/middleware/authMiddleware.js` to ensure:
  - `authenticateToken` extracts user ID correctly
  - `isAdmin` middleware exists and works
- [ ] Test basic endpoints:
  ```bash
  curl -X POST http://localhost:3000/api/listening/log-play \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"userId":"...", "trackId":"...", "completionPercentage":80, ...}'
  ```

---

## Phase 2: Core Features - Track Play Logging (Week 1-2)

### Frontend Integration (Flutter)
- [ ] Create track play event in music player:
  ```dart
  // lib/features/music_player/data/repositories/player_repository.dart
  Future<void> logTrackPlay(TrackPlayData playData) async {
    await remoteDataSource.logPlay(playData);
  }
  ```
- [ ] Call on track completion or skip:
  ```dart
  // Track completion
  if (position.inSeconds >= duration.inSeconds - 3) {
    await playerRepository.logTrackPlay(
      TrackPlayData(
        userId: userId,
        trackId: trackId,
        timeListenedSeconds: position.inSeconds,
        totalDurationSeconds: duration.inSeconds,
        completionPercentage: (position / duration * 100).toInt(),
        wasSkipped: false,
      ),
    );
  }
  ```
- [ ] Test by playing tracks and verify in database:
  ```sql
  SELECT * FROM user_track_listening_history 
  WHERE user_id = 'test-user' 
  ORDER BY played_at DESC LIMIT 10;
  ```

### Backend Validation
- [ ] Ensure `logTrackPlay` endpoint validates:
  - ✅ Required fields present
  - ✅ Completion percentage 0-100
  - ✅ User authorization
- [ ] Test error cases:
  ```bash
  # Missing fields
  curl -X POST http://localhost:3000/api/listening/log-play \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"trackId":"..."}'  # Missing userId, trackId

  # Invalid completion %
  curl -X POST http://localhost:3000/api/listening/log-play \
    -H "Authorization: Bearer $TOKEN" \
    -d '{..., "completionPercentage": 150}'
  ```

---

## Phase 2: User Preferences (Week 2)

### Like/Dislike Endpoints
- [ ] Implement like endpoint:
  ```bash
  POST /api/listening/track/:trackId/like
  # Response: { "success": true, "preference": 1 }
  ```
- [ ] Implement dislike endpoint:
  ```bash
  POST /api/listening/track/:trackId/dislike
  # Response: { "success": true, "preference": -1 }
  ```
- [ ] Test like/dislike workflow:
  ```sql
  SELECT * FROM user_track_preferences 
  WHERE user_id = 'test-user' 
  ORDER BY preferred_at DESC;
  ```

### Flutter UI Integration
- [ ] Add like/dislike buttons to now playing screen:
  ```dart
  // lib/features/music_player/presentation/widgets/now_playing.dart
  IconButton(
    icon: Icon(Icons.favorite_border),
    onPressed: () => playerBloc.add(
      LikeTrackEvent(trackId: currentTrack.id)
    ),
  )
  ```
- [ ] Visual feedback when track is liked/disliked:
  ```dart
  Icon(
    isLiked ? Icons.favorite : Icons.favorite_border,
    color: isLiked ? Colors.red : Colors.grey,
  )
  ```

---

## Phase 3: Content Features (Week 2-3)

### Populate Track Metadata
- [ ] Initialize `track_content_features` from existing tracks:
  ```sql
  INSERT INTO track_content_features (track_id, genres, language, year, popularity_score)
  SELECT 
    track_id, 
    genres, 
    language, 
    year,
    COALESCE(CAST(popularity_score AS DECIMAL), 0)
  FROM tracks
  WHERE track_id NOT IN (SELECT track_id FROM track_content_features)
  ON CONFLICT DO NOTHING;
  ```
- [ ] Verify: `SELECT COUNT(*) FROM track_content_features;` should match track count

### Audio Features ML Pipeline
- [ ] Setup ML feature extraction (3 options):

  **Option A: Spotify API** (if using Spotify data)
  ```javascript
  const spotifyApi = require('spotify-api');
  async function enrichTrackFeatures(trackId, spotifyId) {
    const features = await spotifyApi.getAudioFeatures(spotifyId);
    await supabase.from('track_content_features')
      .update({
        energy_level: features.energy,
        danceability: features.danceability,
        acousticness: features.acousticness,
        instrumentalness: features.instrumentalness
      })
      .eq('track_id', trackId);
  }
  ```

  **Option B: ML4Audio Library** (open source)
  ```bash
  npm install essentia-ml4audio
  ```

  **Option C: Pre-computed (fastest for MVP)**
  ```sql
  UPDATE track_content_features 
  SET 
    energy_level = RANDOM() * 1.0,
    danceability = RANDOM() * 1.0,
    acousticness = RANDOM() * 1.0
  WHERE energy_level IS NULL;
  ```

- [ ] Store embeddings (use pre-trained model or train custom)
  ```javascript
  // Example: Use universal-sentence-encoder for track title/artist embedding
  const use = require('@tensorflow-models/universal-sentence-encoder');
  const embeddings = await use.embed(["track title", "artist name"]);
  // Store as JSON: { "title_embedding": [0.1, 0.2, ...], "artist_embedding": [...] }
  ```

### Similarity Calculation
- [ ] Create batch job to calculate similar tracks:
  ```javascript
  // src/jobs/calculateSimilarTracks.js
  async function calculateSimilarTracks() {
    const tracks = await supabase.from('track_content_features').select('*');
    
    for (const track of tracks) {
      const similar = await findSimilarTracks(track);
      await supabase.from('track_content_features')
        .update({ similar_track_ids: similar.map(t => t.track_id) })
        .eq('track_id', track.track_id);
    }
  }
  ```
- [ ] Schedule to run daily: `node src/jobs/calculateSimilarTracks.js`

---

## Phase 3: Affinity Calculation (Week 3)

### Genre Affinity Job
- [ ] Create batch job:
  ```javascript
  // src/jobs/calculateGenreAffinity.js
  async function calculateAllUserAffinities() {
    const users = await supabase.from('users').select('user_id');
    
    for (const user of users) {
      await calculateGenreAffinity(user.user_id);
      console.log(`Calculated affinity for ${user.user_id}`);
    }
  }
  ```
- [ ] Schedule daily (e.g., 2 AM UTC): `node_cron` or similar
  ```javascript
  const cron = require('node-cron');
  cron.schedule('0 2 * * *', calculateAllUserAffinities);
  ```
- [ ] Monitor: Track count of updated affinity records

### Mood Affinity
- [ ] Same as genre affinity (see `user_mood_affinity` table)
- [ ] Extract mood from track metadata or ML

### Test Affinity Calculation
- [ ] Create test data in database
- [ ] Run affinity job manually
- [ ] Verify results:
  ```sql
  SELECT * FROM user_genre_affinity 
  WHERE user_id = 'test-user' 
  ORDER BY affinity_score DESC 
  LIMIT 10;
  ```

---

## Phase 4: Recommendations (Week 3-4)

### Recommendation Algorithms
- [ ] Implement all 5 algorithms in controller:
  - ✅ Content-based similarity (`getContentBasedRecommendations`)
  - ✅ Genre affinity discovery (`getDiscoveryRecommendations`)
  - ✅ Trending in user taste (`getTrendingRecommendations`)
  - ✅ Mood-based (`getMoodBasedRecommendations`)
  - ✅ Cold-start/onboarding (`getColdStartRecommendations`)

- [ ] Test each algorithm:
  ```bash
  curl -H "Authorization: Bearer $TOKEN" \
    'http://localhost:3000/api/recommendations?type=discovery&limit=20'
  curl -H "Authorization: Bearer $TOKEN" \
    'http://localhost:3000/api/recommendations?type=similar_to_liked&limit=20'
  curl -H "Authorization: Bearer $TOKEN" \
    'http://localhost:3000/api/recommendations?type=trending&limit=20'
  ```

### Recommendation Cache
- [ ] Implement caching strategy:
  - Cache recommendations for 6-12 hours
  - Invalidate on preference change or new play
  - Manual cleanup daily
- [ ] Create cache cleanup cron job:
  ```javascript
  cron.schedule('0 * * * *', async () => {
    const { error } = await supabase
      .from('user_recommendations_cache')
      .delete()
      .lt('expires_at', new Date());
    console.log(error ? 'Cache cleanup failed' : 'Cache cleaned');
  });
  ```

### Randomness Injection
- [ ] Test randomness feature:
  ```bash
  curl -H "Authorization: Bearer $TOKEN" \
    'http://localhost:3000/api/recommendations?type=discovery&limit=50'
  # Should see ~7-8 random tracks if randomness_percentage is 15%
  ```

---

## Phase 4: Frontend Integration (Week 4)

### Recommendation UI
- [ ] Create recommendations screen:
  ```dart
  // lib/features/discovery/presentation/pages/recommendations_page.dart
  class RecommendationsPage extends StatelessWidget {
    @override
    Widget build(BuildContext context) {
      return BlocBuilder<RecommendationBloc, RecommendationState>(
        builder: (context, state) {
          if (state is RecommendationLoading) {
            return LoadingWidget();
          }
          if (state is RecommendationLoaded) {
            return ListView.builder(
              itemCount: state.tracks.length,
              itemBuilder: (context, index) {
                return TrackTile(track: state.tracks[index]);
              },
            );
          }
          return ErrorWidget();
        },
      );
    }
  }
  ```

- [ ] Add tabs for recommendation types:
  ```dart
  DefaultTabController(
    length: 4,
    child: Column(
      children: [
        TabBar(tabs: [
          Tab(text: 'Discovery'),
          Tab(text: 'Similar'),
          Tab(text: 'Trending'),
          Tab(text: 'Mood'),
        ]),
        TabBarView(children: [
          // Each tab loads different recommendation type
        ]),
      ],
    ),
  )
  ```

### Analytics Integration
- [ ] Track recommendation clicks:
  ```dart
  GTAnalytics.logEvent(
    'recommendation_clicked',
    {
      'recommendation_type': 'discovery',
      'track_id': track.id,
      'position': index,
    },
  );
  ```

---

## Testing & QA (Week 4)

### Unit Tests
- [ ] Test affinity calculation logic
- [ ] Test recommendation algorithms
- [ ] Test randomness injection

### Integration Tests
- [ ] Full flow: play track → log → update affinity → get recommendations
- [ ] Cache hit/miss scenarios
- [ ] Preference changes invalidate cache

### Performance Tests
- [ ] Recommendation query performance < 200ms (with cache)
- [ ] Affinity calculation for 1000 users < 5 min
- [ ] Database indexes working correctly

### Manual Testing
- [ ] Create test user account
- [ ] Play 20+ tracks with varied completion %
- [ ] Like/dislike some tracks
- [ ] Check recommendations after 30 min (affinity job runs)
- [ ] Verify recommendations are relevant

---

## Monitoring & Observability

### Logging
```javascript
// Log all recommendations served
console.log(`[REC] User ${userId} got ${trackIds.length} recommendations from ${type} (cache: ${fromCache})`);

// Log affinity calculations
console.log(`[AFFINITY] Calculated for user ${userId}: ${affinityCount} genres`);
```

### Metrics to Track
| Metric | Target | Alert If |
|--------|--------|----------|
| Recommendation latency (cache hit) | < 100ms | > 200ms |
| Recommendation latency (compute) | < 500ms | > 1000ms |
| Cache hit rate | > 85% | < 70% |
| Database query time | < 100ms | > 200ms |
| Affinity job duration | < 1 min (1000 users) | > 2 min |

### Database Health
```sql
-- Monitor table sizes
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables
WHERE tablename LIKE 'user_%'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Check index usage
SELECT schemaname, tablename, indexname, idx_scan 
FROM pg_stat_user_indexes 
WHERE schemaname = 'public'
ORDER BY idx_scan DESC;
```

---

## Rollout Plan

### Week 1: Canary Deployment
- [ ] Deploy to 5% of users
- [ ] Monitor error rates, latency
- [ ] Verify recommendation quality manually

### Week 2: Beta Deployment
- [ ] Deploy to 25% of users
- [ ] Collect quality feedback
- [ ] Monitor cache hit rate

### Week 3: Full Deployment
- [ ] Deploy to 100% of users
- [ ] Monitor all metrics
- [ ] Keep rollback plan ready

### Rollback Procedure
If recommendations quality is poor:
```sql
-- Disable recommendations
UPDATE user_onboarding_preferences 
SET allow_recommendations = FALSE 
WHERE created_at > NOW() - INTERVAL '1 day';

-- Clear cache
DELETE FROM user_recommendations_cache;

-- Revert code and redeploy
```

---

## Success Criteria

✅ **Complete when:**
- [ ] 95%+ track plays are logged with completion %
- [ ] 10%+ users have set preferences (like/dislike)
- [ ] Cache hit rate > 85%
- [ ] Recommendation CTR > 5%
- [ ] User satisfaction with discovery > 4.0/5.0
- [ ] No errors in logs, latency < 200ms P95

---

## Useful Commands

```bash
# Run ALL migrations
psql -h db.supabase.co -U postgres -d postgres -f 002_listening_history_and_recommendations.sql

# Calculate affinity for specific user
curl -X POST http://localhost:3000/api/admin/listening/calculate-affinity/{userId} \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Clean expired caches
curl http://localhost:3000/api/admin/cache/cleanup \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Monitor listening history (psql)
SELECT 
  DATE(played_at) as date,
  COUNT(*) as plays,
  AVG(completion_percentage) as avg_completion,
  SUM(time_listened_seconds) as total_time
FROM user_track_listening_history
GROUP BY DATE(played_at)
ORDER BY date DESC
LIMIT 7;
```

---

## Troubleshooting

### Issue: Recommendations are repetitive
- **Cause:** Randomness % too low or affinity scores skewed
- **Fix:** Increase `randomness_percentage` to 20-25%
- **Check:** Verify genre affinity is calculated correctly

### Issue: Cache not working
- **Cause:** Cache expiry too short or recommendations changing too frequently
- **Fix:** Increase cache TTL to 12 hours
- **Check:** Verify `expires_at` column is being set

### Issue: Cold-start recommendations are bad
- **Cause:** Onboarding not capturing preferences
- **Fix:** Enhance onboarding flow with genre/mood selection
- **Check:** Verify `user_onboarding_preferences.favorite_genres` is populated

### Issue: Performance degradation
- **Cause:** Missing indexes or too many recommendations computing at once
- **Fix:** Verify indexes are being used (check query plans)
- **Check:** Consider implementing request queue/rate limiting

---

## Next Steps After Completion

1. **A/B Test** different algorithms (similarity vs. discovery vs. trending)
2. **User Feedback Loop** - Gather data on which recommendations users click
3. **ML Improvements** - Train embeddings on user interaction data
4. **Mood Detection** - Auto-tag tracks with mood using audio analysis
5. **Social Recommendations** - "What your friends are listening to"
6. **Real-Time Updates** - Update cache when user plays high-completion track

