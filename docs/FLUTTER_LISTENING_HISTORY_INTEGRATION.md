# Listening History & Smart Queue Integration Guide

## Overview
Complete integration of listening history tracking, content-based recommendations, and intelligent queue management with user preference support.

**Implementation Timeline:** 3-4 weeks  
**Complexity:** Medium-High (requires coordination between Flutter and Node.js)

---

## Architecture Overview

### Data Flow Diagram
```
┌─────────────────────────────────────────────────────────────────┐
│                        FLUTTER CLIENT                           │
├─────────────────────────────────────────────────────────────────┤
│  Player Cubit → Listening History Bloc → Listening History API │
│                                                                 │
│  Enhanced Queue Bloc → Smart Fill → Recommendations API        │
└─────────────────────────────────────────────────────────────────┘
                            ↓ ↑
                   (Dio HTTP Requests)
                            ↓ ↑
┌─────────────────────────────────────────────────────────────────┐
│                     NODE.JS BACKEND                            │
├─────────────────────────────────────────────────────────────────┤
│  Listening History Controller ─┐                               │
│    ├─ Log Play                 ├─→ Supabase PostgreSQL         │
│    ├─ Preferences              │   ├─ user_track_listening      │
│    └─ Recommendations          │   ├─ user_track_preferences    │
│                                │   ├─ user_genre_affinity       │
│  Enhanced Queue Controller ────┤   ├─ user_mood_affinity        │
│    ├─ Smart Fill               │   ├─ track_content_features    │
│    ├─ Queue Preferences        │   └─ user_recommendations_cache│
│    └─ Analytics                │                                │
│                                └─→ Redis Cache                 │
│                                    ├─ Queue Lists              │
│                                    ├─ Preferences              │
│                                    └─ Track Metadata           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Backend Setup (Week 1)

### Step 1.1: Deploy Database Migration
```bash
# In Supabase SQL editor, run:
-- Copy entire content from:
-- docs/migrations/002_listening_history_and_recommendations.sql

-- Verify tables created:
SELECT table_name FROM information_schema.tables 
WHERE table_name LIKE 'user_%' OR table_name LIKE 'track_content%';
```

**Expected Tables:** 10 tables + 4 views created

### Step 1.2: Register Backend Routes
Update `src/index.js`:

```javascript
// Add these imports
const listeningHistoryRoutes = require('./routes/listeningHistoryRoutes');
const enhancedQueueRoutes = require('./routes/user/enhancedQueueRoutes');

// Register listening history routes
app.use('/api/listening', listeningHistoryRoutes);

// Register enhanced queue routes  
app.use('/api/user/queue', enhancedQueueRoutes);
```

### Step 1.3: Implement Onboarding Preferences Endpoint
Create `src/controllers/user/onboardingController.js`:

```javascript
const { supabase } = require('../../db/supabaseClient');

exports.getOnboardingPreferences = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data, error } = await supabase
      .from('user_onboarding_preferences')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    res.json(data || {
      user_id: userId,
      favorite_genres: [],
      favorite_moods: [],
      favorite_artists: [],
      allow_recommendations: true,
      randomness_percentage: 15,
      allow_new_releases: true,
      allow_trending_tracks: true,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
};

exports.saveOnboardingPreferences = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data, error } = await supabase
      .from('user_onboarding_preferences')
      .upsert({
        user_id: userId,
        ...req.body,
        completed_at: new Date(),
      })
      .select();

    if (error) throw error;

    res.json({ success: true, data: data[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save preferences' });
  }
};

exports.getListeningStats = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Get basic stats
    const { data: history } = await supabase
      .from('user_track_listening_history')
      .select('*')
      .eq('user_id', userId);

    const { data: likes } = await supabase
      .from('user_track_preferences')
      .select('preference')
      .eq('user_id', userId);

    const { data: artists } = await supabase
      .from('user_artist_listening_history')
      .select('artist_id')
      .eq('user_id', userId)
      .order('play_count', { ascending: false })
      .limit(5);

    const stats = {
      total_tracks_played: history?.length || 0,
      total_listening_time_seconds: history?.reduce((sum, h) => sum + h.time_listened_seconds, 0) || 0,
      average_completion_percentage: history?.length 
        ? history.reduce((sum, h) => sum + h.completion_percentage, 0) / history.length
        : 0,
      skip_count: history?.filter(h => h.was_skipped).length || 0,
      like_count: likes?.filter(l => l.preference === 1).length || 0,
      dislike_count: likes?.filter(l => l.preference === -1).length || 0,
      top_artists: artists?.map(a => a.artist_id) || [],
      last_played_at: history?.[0]?.played_at || new Date(),
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
};

module.exports = exports;
```

Add to `src/routes/userRoutes.js`:
```javascript
const onboardingRoutes = require('./user/onboardingRoutes');
router.use('/onboarding', onboardingRoutes);
```

### Step 1.4: Test Backend Endpoints
```bash
# Test listening history logging
curl -X POST http://localhost:3000/api/listening/log-play \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user-id",
    "trackId": "test-track-id",
    "timeListenedSeconds": 180,
    "totalDurationSeconds": 240,
    "completionPercentage": 75,
    "listeningContext": "playlist"
  }'

# Expected response: 201 Created

# Test queue preferences
curl -X POST http://localhost:3000/api/user/queue/preferences \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "minQueueSize": 30,
    "preferredRecommendationType": "discovery"
  }'
```

---

## Phase 2: Flutter Integration - Listening History (Week 2)

### Step 2.1: Register Dependencies
Update `lib/init_dependencies.dart`:

```dart
// Import new packages
import 'package:dio/dio.dart';
import 'package:bloc/bloc.dart';
import 'features/listening_history/data/datasources/listening_history_remote_data_source.dart';
import 'features/listening_history/data/repositories/listening_history_repository.dart';
import 'features/listening_history/presentation/bloc/listening_history_bloc.dart';

// Register listening history dependencies
final getIt = GetIt.instance;

void setupListeningHistoryDependencies() {
  // Data sources
  getIt.registerSingleton<ListeningHistoryRemoteDataSource>(
    ListeningHistoryRemoteDataSourceImpl(
      dio: getIt(),
      baseUrl: getIt<String>(), // Your API base URL
    ),
  );

  // Repositories
  getIt.registerSingleton<ListeningHistoryRepository>(
    ListeningHistoryRepositoryImpl(
      remoteDataSource: getIt(),
    ),
  );

  // Blocs
  getIt.registerSingleton<ListeningHistoryBloc>(
    ListeningHistoryBloc(repository: getIt()),
  );
}

// Call in main setupDependencies()
void setupDependencies() {
  // ... existing setup ...
  setupListeningHistoryDependencies();
}
```

### Step 2.2: Integrate with Player Cubit
Update `lib/core/player/player_cubit.dart`:

```dart
class PlayerCubit extends Cubit<PlayerState> {
  final AudioPlayer audioPlayer;
  final ListeningHistoryBloc listeningHistoryBloc; // Add this
  
  DateTime? _trackStartTime;
  int _lastReportedSeconds = 0;

  PlayerCubit({
    required this.audioPlayer,
    required this.listeningHistoryBloc, // Add to constructor
  }) : super(const PlayerInitial()) {
    // ... existing setup ...
    
    // Listen to position changes to log listening data
    audioPlayer.positionStream.listen((position) {
      _trackPositionUpdated(position);
    });
  }

  // Log track play when user goes to next/prev or after time threshold
  void _trackPositionUpdated(Duration position) {
    // Report every 5 seconds or on pause/stop
    if (position.inSeconds - _lastReportedSeconds >= 5 ||
        audioPlayer.playerState.processingState == ProcessingState.completed) {
      _lastReportedSeconds = position.inSeconds;
      _logTrackEngagement();
    }
  }

  void _logTrackEngagement() {
    final current = state;
    if (current is! PlayerLoaded) return;

    final position = audioPlayer.position;
    final duration = audioPlayer.duration ?? const Duration();
    final completionPercentage = duration.inMilliseconds > 0
        ? (position.inMilliseconds / duration.inMilliseconds * 100)
        : 0;

    // Only log if progress > 5%
    if (completionPercentage > 5) {
      listeningHistoryBloc.add(
        LogTrackPlayEvent(
          trackId: current.currentTrack.id,
          timeListenedSeconds: position.inSeconds,
          totalDurationSeconds: duration.inSeconds,
          completionPercentage: completionPercentage,
          listeningContext: current.playlistContext ?? 'library',
          contextId: current.contextId,
        ),
      );
    }
  }

  /// Call when track completes
  Future<void> onTrackCompleted() async {
    final current = state;
    if (current is! PlayerLoaded) return;

    final duration = audioPlayer.duration ?? const Duration();
    final completionPercentage = (audioPlayer.position.inMilliseconds / 
        duration.inMilliseconds * 100).clamp(0, 100);

    // Log final completion
    listeningHistoryBloc.add(
      LogTrackPlayEvent(
        trackId: current.currentTrack.id,
        timeListenedSeconds: audioPlayer.position.inSeconds,
        totalDurationSeconds: duration.inSeconds,
        completionPercentage: completionPercentage,
        wasSkipped: false,
        listeningContext: current.playlistContext ?? 'library',
      ),
    );

    // Move to next track
    await next();
  }

  /// Call when user skips
  Future<void> skipTrack() async {
    final current = state;
    if (current is! PlayerLoaded) return;

    // Log skip
    listeningHistoryBloc.add(
      LogTrackPlayEvent(
        trackId: current.currentTrack.id,
        timeListenedSeconds: audioPlayer.position.inSeconds,
        totalDurationSeconds: audioPlayer.duration?.inSeconds ?? 0,
        completionPercentage: 
          (audioPlayer.position.inMilliseconds / 
           (audioPlayer.duration?.inMilliseconds ?? 1) * 100).clamp(0, 100),
        wasSkipped: true,
        skipAtSeconds: audioPlayer.position.inSeconds,
      ),
    );

    await next();
  }
}
```

### Step 2.3: Add Like/Dislike UI
Create `lib/features/listening_history/presentation/widgets/track_action_buttons.dart`:

```dart
class TrackActionButtons extends StatelessWidget {
  final String trackId;
  final VoidCallback onLike;
  final VoidCallback onDislike;
  final bool isLiked;
  final bool isDisliked;

  const TrackActionButtons({
    required this.trackId,
    required this.onLike,
    required this.onDislike,
    this.isLiked = false,
    this.isDisliked = false,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        // Dislike button
        IconButton(
          icon: Icon(
            isDisliked ? Icons.thumb_down : Icons.thumb_down_outlined,
            color: isDisliked ? Colors.red : Colors.grey,
          ),
          onPressed: onDislike,
        ),

        // Like button
        IconButton(
          icon: Icon(
            isLiked ? Icons.favorite : Icons.favorite_border,
            color: isLiked ? Colors.red : Colors.grey,
          ),
          onPressed: onLike,
        ),
      ],
    );
  }
}
```

Add to now playing screen:
```dart
BlocBuilder<ListeningHistoryBloc, ListeningHistoryState>(
  builder: (context, state) {
    return TrackActionButtons(
      trackId: currentTrack.id,
      isLiked: isLikedTrack,
      isDisliked: isDislikedTrack,
      onLike: () {
        context.read<ListeningHistoryBloc>().add(
          LikeTrackEvent(currentTrack.id),
        );
      },
      onDislike: () {
        context.read<ListeningHistoryBloc>().add(
          DislikeTrackEvent(currentTrack.id),
        );
      },
    );
  },
)
```

---

## Phase 3: Flutter Integration - Enhanced Queue (Week 2-3)

### Step 3.1: Register Queue Dependencies
Update `lib/init_dependencies.dart`:

```dart
import 'features/player/data/datasources/player_queue_remote_data_source.dart';
import 'features/player/data/repositories/player_queue_repository.dart';
import 'features/player/presentation/bloc/enhanced_queue_bloc.dart';

void setupQueueDependencies() {
  // Data sources
  getIt.registerSingleton<PlayerQueueRemoteDataSource>(
    PlayerQueueRemoteDataSourceImpl(
      dio: getIt(),
      baseUrl: getIt<String>(),
    ),
  );

  // Repositories
  getIt.registerSingleton<PlayerQueueRepository>(
    PlayerQueueRepositoryImpl(
      remoteDataSource: getIt(),
    ),
  );

  // Bloc
  getIt.registerSingleton<EnhancedQueueBloc>(
    EnhancedQueueBloc(
      queueRepository: getIt(),
      audioPlayer: getIt(), // Inject AudioPlayer
    ),
  );
}

// Call in setupDependencies()
void setupDependencies() {
  // ... existing ...
  setupQueueDependencies();
}
```

### Step 3.2: Integrate with PlayerCubit
```dart
class PlayerCubit extends Cubit<PlayerState> {
  final EnhancedQueueBloc queueBloc; // Add this

  PlayerCubit({
    required this.audioPlayer,
    required this.listeningHistoryBloc,
    required this.queueBloc, // Add to constructor
  }) : super(const PlayerInitial()) {
    
    // Initialize queue
    queueBloc.add(const InitializeEnhancedQueueEvent());

    // Listen for queue exhaustion
    audioPlayer.sequenceStateStream.listen((sequenceState) {
      if (sequenceState?.currentIndex == (sequenceState?.sequence.length ?? 0) - 1) {
        // Near end of queue, smart fill
        queueBloc.add(SmartFillQueueEvent());
      }
    });
  }
}
```

### Step 3.3: Create Queue UI
Create `lib/features/player/presentation/pages/queue_page.dart`:

```dart
class QueuePage extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Queue')),
      body: BlocBuilder<EnhancedQueueBloc, EnhancedQueueState>(
        builder: (context, state) {
          if (state is QueueLoading) {
            return const Center(child: CircularProgressIndicator());
          }

          if (state is QueueLoaded) {
            return ListView.builder(
              itemCount: state.queue.length,
              itemBuilder: (context, index) {
                final trackId = state.queue[index];
                return TrackTile(
                  trackId: trackId,
                  isCurrentTrack: index == 0,
                  onRemove: () {
                    context.read<EnhancedQueueBloc>().add(
                      RemoveTrackFromQueueEvent(trackId),
                    );
                  },
                  onReorder: (newIndex) {
                    context.read<EnhancedQueueBloc>().add(
                      ReorderQueueEvent(
                        fromIndex: index,
                        toIndex: newIndex,
                      ),
                    );
                  },
                );
              },
            );
          }

          if (state is QueueError) {
            return Center(child: Text('Error: ${state.message}'));
          }

          return const Center(child: Text('Queue empty'));
        },
      ),
    );
  }
}
```

---

## Phase 4: Onboarding Integration (Week 3)

### Step 4.1: Create Onboarding Screen
Create `lib/features/onboarding/presentation/pages/music_preferences_page.dart`:

```dart
class MusicPreferencesPage extends StatefulWidget {
  @override
  State<MusicPreferencesPage> createState() => _MusicPreferencesPageState();
}

class _MusicPreferencesPageState extends State<MusicPreferencesPage> {
  List<String> selectedGenres = [];
  List<String> selectedMoods = [];
  String selectedLanguage = 'en';
  double randomnessPercentage = 15;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Music Preferences')),
      body: SingleChildScrollView(
        child: Column(
          children: [
            // Genre selection
            _buildSectionTitle('Favorite Genres'),
            _buildGenreChips(),

            // Mood selection
            _buildSectionTitle('Preferred Moods'),
            _buildMoodChips(),

            // Language preference
            _buildSectionTitle('Language'),
            _buildLanguageDropdown(),

            // Randomness slider
            _buildSectionTitle('Discovery (Randomness)'),
            Slider(
              value: randomnessPercentage,
              min: 0,
              max: 50,
              divisions: 5,
              label: '${randomnessPercentage.toStringAsFixed(0)}%',
              onChanged: (value) {
                setState(() => randomnessPercentage = value);
              },
            ),

            // Save button
            ElevatedButton(
              onPressed: _savePreferences,
              child: const Text('Save Preferences'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _savePreferences() async {
    final prefs = UserOnboardingPreferences(
      userId: context.read<AuthBloc>().state.user!.id,
      favoriteGenres: selectedGenres,
      favoriteMoods: selectedMoods,
      preferredLanguage: selectedLanguage,
      randomnessPercentage: randomnessPercentage,
    );

    context.read<ListeningHistoryBloc>().add(
      SaveOnboardingPreferencesEvent(prefs),
    );

    // Show success and navigate
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Preferences saved!')),
      );
      Navigator.pop(context);
    }
  }

  Widget _buildSectionTitle(String title) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Text(title, style: Theme.of(context).textTheme.headlineSmall),
    );
  }

  Widget _buildGenreChips() {
    final genres = ['Rock', 'Pop', 'Hip-Hop', 'Jazz', 'Classical', 'EDM'];
    return Wrap(
      spacing: 8,
      children: genres.map((genre) {
        final isSelected = selectedGenres.contains(genre);
        return FilterChip(
          label: Text(genre),
          selected: isSelected,
          onSelected: (selected) {
            setState(() {
              if (selected) {
                selectedGenres.add(genre);
              } else {
                selectedGenres.remove(genre);
              }
            });
          },
        );
      }).toList(),
    );
  }

  Widget _buildMoodChips() {
    final moods = ['Happy', 'Sad', 'Energetic', 'Calm', 'Party'];
    return Wrap(
      spacing: 8,
      children: moods.map((mood) {
        final isSelected = selectedMoods.contains(mood);
        return FilterChip(
          label: Text(mood),
          selected: isSelected,
          onSelected: (selected) {
            setState(() {
              if (selected) {
                selectedMoods.add(mood);
              } else {
                selectedMoods.remove(mood);
              }
            });
          },
        );
      }).toList(),
    );
  }

  Widget _buildLanguageDropdown() {
    return DropdownButton<String>(
      value: selectedLanguage,
      items: [
        DropdownMenuItem(value: 'en', child: Text('English')),
        DropdownMenuItem(value: 'es', child: Text('Spanish')),
        DropdownMenuItem(value: 'fr', child: Text('French')),
        DropdownMenuItem(value: 'hi', child: Text('Hindi')),
      ],
      onChanged: (value) {
        setState(() => selectedLanguage = value!);
      },
    );
  }
}
```

---

## Phase 5: Testing & Optimization (Week 4)

### Test Checklist

```
Listening History:
 ☐ Track plays logged with >70% completion
 ☐ Likes/dislikes save to database
 ☐ Completion % calculated correctly
 ☐ Skip events tracked

Queue Management:
 ☐ Queue maintained at min size
 ☐ Smart fill triggers correctly
 ☐ Preferences persist across sessions
 ☐ Reordering works smoothly

Recommendations:
 ☐ Discovery recommendations load
 ☐ Cache hits > 85%
 ☐ Randomness injection working
 ☐ User preferences respected

Performance:
 ☐ Listening log < 500ms
 ☐ Queue fetch < 200ms
 ☐ Recommendations < 500ms
 ☐ No UI blocking
```

### Performance Monitoring

```dart
// Add to player cubit
void _logPerformance(String operation, Duration elapsed) {
  if (elapsed.inMilliseconds > 500) {
    print('⚠️ SLOW: $operation took ${elapsed.inMilliseconds}ms');
  }
}

// Use it
final stopwatch = Stopwatch()..start();
await logTrackPlay();
_logPerformance('logTrackPlay', stopwatch.elapsed);
```

---

## API Endpoints Summary

### Listening History
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/listening/log-play` | Log track play |
| POST | `/api/listening/track/:id/like` | Like track |
| POST | `/api/listening/track/:id/dislike` | Dislike track |
| GET | `/api/recommendations` | Get recommendations |
| POST | `/api/user/onboarding/preferences` | Save preferences |

### Queue Management
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/user/queue` | Get queue |
| POST | `/api/user/queue/smart-fill` | Auto-fill queue |
| POST | `/api/user/queue/preferences` | Save queue prefs |
| POST | `/api/user/queue/prioritize` | Move track forward |
| GET | `/api/user/queue/analytics` | Queue health stats |

---

## Troubleshooting

### Issue: Listening history not being logged
**Solution:** 
- Check completion % > 5%
- Verify user ID is set in bloc
- Check network tab in Flutter DevTools

### Issue: Queue not auto-filling
**Solution:**
- Verify queue below threshold
- Check Redis connection
- Verify recommendation endpoint working

### Issue: Recommendations are repetitive
**Solution:**
- Increase `randomness_percentage` in user preferences
- Verify different recommendation types are being tested
- Check if user has liked enough tracks for discovery

### Issue: UI freezes during queue operations
**Solution:**
- Use `SmartFillQueueEvent` async (don't wait)
- Implement pagination for large queues
- Cache queue locally

---

## Next Steps

1. ✅ Deploy database migration
2. ✅ Implement listening history logging
3. ✅ Build queue preferences system
4. ✅ Integrate recommendations
5. ⏭️ A/B test recommendation algorithms
6. ⏭️ Implement mood detection (ML)
7. ⏭️ Add social recommendations ("Friends are listening")
8. ⏭️ Real-time queue updates via WebSockets

