-- ============================================================================
-- Migration 002: Listening History & Content-Based Recommendation System
-- ============================================================================
-- Adds tables to track user listening behavior and enable production-grade
-- content-based recommendations with support for tracks, albums, artists, and playlists.
-- Created: 2026-03-24

-- ============================================================================
-- 1. USER LISTENING HISTORY (Tracks)
-- ============================================================================
-- Core table: Tracks every play with engagement metrics
CREATE TABLE public.user_track_listening_history (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  track_id UUID NOT NULL,
  
  -- Engagement metrics
  played_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  time_listened_seconds INTEGER NOT NULL DEFAULT 0, -- Seconds actually listened
  total_duration_seconds INTEGER NOT NULL, -- Total duration of track
  completion_percentage DECIMAL(5, 2) NOT NULL DEFAULT 0, -- 0-100, percentage of track heard
  
  -- Skip & completion data
  was_skipped BOOLEAN NOT NULL DEFAULT FALSE,
  skip_at_seconds INTEGER, -- If skipped, at what second?
  
  -- Context & metadata
  listening_context TEXT, -- 'playlist', 'album', 'search', 'recommendation', 'radio', 'library'
  context_id UUID, -- playlist_id or album_id if applicable
  device_type TEXT DEFAULT 'mobile', -- 'mobile', 'web', 'desktop', 'tv'
  
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(track_id) ON UPDATE CASCADE ON DELETE CASCADE
) TABLESPACE pg_default;

-- Indexes for fast queries
CREATE INDEX idx_user_track_listening_user_id ON public.user_track_listening_history(user_id);
CREATE INDEX idx_user_track_listening_track_id ON public.user_track_listening_history(track_id);
CREATE INDEX idx_user_track_listening_user_played ON public.user_track_listening_history(user_id, played_at DESC);
CREATE INDEX idx_user_track_listening_context ON public.user_track_listening_history(user_id, listening_context);
CREATE INDEX idx_user_track_listening_completion ON public.user_track_listening_history(user_id, completion_percentage DESC);

-- ============================================================================
-- 2. USER TRACK PREFERENCES (Likes/Dislikes)
-- ============================================================================
-- Explicit feedback from users: likes, dislikes, and neutral
CREATE TABLE public.user_track_preferences (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  track_id UUID NOT NULL,
  
  -- Preference: -1 (dislike), 0 (neutral), 1 (like)
  preference INTEGER NOT NULL, -- -1, 0, 1
  
  -- Track audio mood/genre tags derived from content
  mood TEXT[], -- Tags: 'happy', 'sad', 'energetic', 'melancholic', 'party', etc.
  
  preferred_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(track_id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (user_id, track_id) -- One preference per track per user
) TABLESPACE pg_default;

CREATE INDEX idx_user_track_pref_user ON public.user_track_preferences(user_id);
CREATE INDEX idx_user_track_pref_track ON public.user_track_preferences(track_id);
CREATE INDEX idx_user_track_pref_value ON public.user_track_preferences(user_id, preference);

-- ============================================================================
-- 3. USER ARTIST LISTENING HISTORY
-- ============================================================================
-- Aggregate artist listening stats
CREATE TABLE public.user_artist_listening_history (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  artist_id UUID NOT NULL,
  
  -- Aggregate stats
  play_count INTEGER NOT NULL DEFAULT 1,
  total_time_listened_seconds INTEGER NOT NULL DEFAULT 0,
  unique_tracks_played INTEGER NOT NULL DEFAULT 1,
  last_played_at TIMESTAMP WITHOUT TIME ZONE,
  
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (artist_id) REFERENCES artists(artist_id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (user_id, artist_id)
) TABLESPACE pg_default;

CREATE INDEX idx_user_artist_listening_user ON public.user_artist_listening_history(user_id);
CREATE INDEX idx_user_artist_listening_artist ON public.user_artist_listening_history(artist_id);
CREATE INDEX idx_user_artist_listening_freq ON public.user_artist_listening_history(user_id, play_count DESC);

-- ============================================================================
-- 4. USER ALBUM LISTENING HISTORY
-- ============================================================================
-- Aggregate album listening stats
CREATE TABLE public.user_album_listening_history (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  album_id UUID NOT NULL,
  
  -- Aggregate stats
  play_count INTEGER NOT NULL DEFAULT 1,
  total_time_listened_seconds INTEGER NOT NULL DEFAULT 0,
  unique_tracks_played INTEGER NOT NULL DEFAULT 1,
  last_played_at TIMESTAMP WITHOUT TIME ZONE,
  
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (album_id) REFERENCES albums(album_id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (user_id, album_id)
) TABLESPACE pg_default;

CREATE INDEX idx_user_album_listening_user ON public.user_album_listening_history(user_id);
CREATE INDEX idx_user_album_listening_album ON public.user_album_listening_history(album_id);
CREATE INDEX idx_user_album_listening_freq ON public.user_album_listening_history(user_id, play_count DESC);

-- ============================================================================
-- 5. PLAYLIST LISTENING HISTORY
-- ============================================================================
-- Track when users listen to playlists
CREATE TABLE public.user_playlist_listening_history (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  playlist_id UUID NOT NULL,
  
  -- Aggregate stats
  play_count INTEGER NOT NULL DEFAULT 1,
  total_time_listened_seconds INTEGER NOT NULL DEFAULT 0,
  last_played_at TIMESTAMP WITHOUT TIME ZONE,
  
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (playlist_id) REFERENCES playlists(playlist_id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (user_id, playlist_id)
) TABLESPACE pg_default;

CREATE INDEX idx_user_playlist_listening_user ON public.user_playlist_listening_history(user_id);
CREATE INDEX idx_user_playlist_listening_playlist ON public.user_playlist_listening_history(playlist_id);

-- ============================================================================
-- 6. TRACK CONTENT FEATURES (for Content-Based Recommendations)
-- ============================================================================
-- Stores content features used for similarity calculations
CREATE TABLE public.track_content_features (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL,
  
  -- Content metadata from Jio Saavn
  genres TEXT[] NOT NULL DEFAULT '{}', -- Denormalized from tracks.genres
  mood TEXT[] NOT NULL DEFAULT '{}', -- 'happy', 'sad', 'energetic', 'melancholic', 'party', etc.
  language TEXT, -- From tracks.language
  year INTEGER, -- From tracks.year
  
  -- Audio features (can be populated via ML pipeline)
  energy_level DECIMAL(3, 2), -- 0.0-1.0 (low to high energy)
  danceability DECIMAL(3, 2), -- 0.0-1.0 (low to high)
  acousticness DECIMAL(3, 2), -- 0.0-1.0 (acoustic to electric)
  instrumentalness DECIMAL(3, 2), -- 0.0-1.0 (low to high instruments)
  popularity_score DECIMAL(5, 2) DEFAULT 0, -- 0.0-100.0
  
  -- Vector embeddings for ML (JSON for flexibility)
  embedding JSONB, -- Store ML embeddings as JSON array: [0.1, 0.2, ...]
  
  -- Similarity cache (updated periodically)
  similar_track_ids UUID[] DEFAULT '{}',
  
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  
  PRIMARY KEY (id),
  FOREIGN KEY (track_id) REFERENCES tracks(track_id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (track_id)
) TABLESPACE pg_default;

CREATE INDEX idx_track_features_genres ON public.track_content_features USING GIN (genres);
CREATE INDEX idx_track_features_mood ON public.track_content_features USING GIN (mood);
CREATE INDEX idx_track_features_language ON public.track_content_features(language);
CREATE INDEX idx_track_features_popularity ON public.track_content_features(popularity_score DESC);

-- ============================================================================
-- 7. USER ONBOARDING PREFERENCES
-- ============================================================================
-- Captures user preferences from onboarding for initial recommendations
CREATE TABLE public.user_onboarding_preferences (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  
  -- Regional & Language preferences
  preferred_language TEXT, -- ISO 639-1: 'en', 'hi', 'ta', 'te', etc.
  preferred_region_id UUID,
  
  -- Genre preferences (from onboarding)
  favorite_genres TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  favorite_moods TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  favorite_artists UUID[] NOT NULL DEFAULT '{}'::UUID[],
  
  -- Discovery preferences
  allow_recommendations BOOLEAN DEFAULT TRUE,
  include_random_songs BOOLEAN DEFAULT TRUE, -- Include some randomness in recommendations
  randomness_percentage DECIMAL(3, 2) DEFAULT 0.15, -- 0-100%, default 15%
  allow_new_releases BOOLEAN DEFAULT TRUE,
  allow_trending_tracks BOOLEAN DEFAULT TRUE,
  
  completed_at TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (preferred_region_id) REFERENCES regions(region_id) ON UPDATE CASCADE ON DELETE SET NULL,
  UNIQUE (user_id)
) TABLESPACE pg_default;

CREATE INDEX idx_onboarding_prefs_user ON public.user_onboarding_preferences(user_id);
CREATE INDEX idx_onboarding_prefs_region ON public.user_onboarding_preferences(preferred_region_id);
CREATE INDEX idx_onboarding_prefs_language ON public.user_onboarding_preferences(preferred_language);

-- ============================================================================
-- 8. RECOMMENDATION CACHE (Pre-computed Recommendations)
-- ============================================================================
-- Stores pre-computed recommendations for fast serving (updated periodically)
CREATE TABLE public.user_recommendations_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  
  -- Recommendation type
  recommendation_type TEXT NOT NULL, -- 'similar_to_liked', 'discovery', 'trending', 'artist_top_tracks', 'mood_based'
  
  -- Recommended items
  recommended_track_ids UUID[] NOT NULL, -- Array of track IDs in score order
  recommended_album_ids UUID[] NOT NULL DEFAULT '{}',
  recommended_artist_ids UUID[] NOT NULL DEFAULT '{}',
  
  -- Metadata
  algorithm_version INTEGER DEFAULT 1, -- Track which algorithm version generated this
  confidence_scores DECIMAL(3, 2)[] DEFAULT '{}', -- Optional confidence score per recommendation
  reasons TEXT[] DEFAULT '{}', -- Why these were recommended: 'liked_artist', 'similar_genre', etc.
  
  -- Cache validity
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITHOUT TIME ZONE, -- Cache expiry for periodic refresh
  
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (user_id, recommendation_type)
) TABLESPACE pg_default;

CREATE INDEX idx_rec_cache_user ON public.user_recommendations_cache(user_id);
CREATE INDEX idx_rec_cache_type ON public.user_recommendations_cache(user_id, recommendation_type);
CREATE INDEX idx_rec_cache_expires ON public.user_recommendations_cache(expires_at);

-- ============================================================================
-- 9. GENRE PREFERENCES (User's Affinity Scores)
-- ============================================================================
-- Calculated genre affinity for each user based on listening history
CREATE TABLE public.user_genre_affinity (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  genre TEXT NOT NULL,
  
  -- Affinity score: -1.0 to 1.0 (more negative = disliked, more positive = liked)
  affinity_score DECIMAL(3, 2) NOT NULL DEFAULT 0,
  
  -- Supporting metrics
  track_count INTEGER DEFAULT 0,
  total_listen_time_seconds INTEGER DEFAULT 0,
  
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (user_id, genre)
) TABLESPACE pg_default;

CREATE INDEX idx_genre_affinity_user ON public.user_genre_affinity(user_id);
CREATE INDEX idx_genre_affinity_score ON public.user_genre_affinity(user_id, affinity_score DESC);

-- ============================================================================
-- 10. MOOD PREFERENCES (User's Mood Affinity Scores)
-- ============================================================================
-- Calculated mood affinity for each user based on listening history
CREATE TABLE public.user_mood_affinity (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  mood TEXT NOT NULL,
  
  -- Affinity score: -1.0 to 1.0
  affinity_score DECIMAL(3, 2) NOT NULL DEFAULT 0,
  
  -- Supporting metrics
  track_count INTEGER DEFAULT 0,
  total_listen_time_seconds INTEGER DEFAULT 0,
  
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (user_id, mood)
) TABLESPACE pg_default;

CREATE INDEX idx_mood_affinity_user ON public.user_mood_affinity(user_id);
CREATE INDEX idx_mood_affinity_score ON public.user_mood_affinity(user_id, affinity_score DESC);

-- ============================================================================
-- VIEWS FOR COMMON RECOMMENDATION QUERIES
-- ============================================================================

-- Get top artists for a user (with listening frequency)
CREATE OR REPLACE VIEW v_user_top_artists AS
SELECT 
  ual.user_id,
  ual.artist_id,
  ual.play_count,
  ual.total_time_listened_seconds,
  ual.unique_tracks_played,
  ual.last_played_at,
  ROW_NUMBER() OVER (PARTITION BY ual.user_id ORDER BY ual.play_count DESC) as rank
FROM public.user_artist_listening_history ual;

-- Get user's liked tracks with content features
CREATE OR REPLACE VIEW v_user_liked_tracks_with_features AS
SELECT 
  utp.user_id,
  utp.track_id,
  utp.preference,
  utp.mood,
  tcf.genres,
  tcf.energy_level,
  tcf.danceability,
  tcf.acousticness
FROM public.user_track_preferences utp
LEFT JOIN public.track_content_features tcf ON utp.track_id = tcf.track_id
WHERE utp.preference = 1; -- Only liked tracks

-- Get recently played tracks for a user
CREATE OR REPLACE VIEW v_user_recent_plays AS
SELECT 
  utlh.user_id,
  utlh.track_id,
  utlh.played_at,
  utlh.time_listened_seconds,
  utlh.completion_percentage,
  utlh.was_skipped,
  ROW_NUMBER() OVER (PARTITION BY utlh.user_id ORDER BY utlh.played_at DESC) as recency_rank
FROM public.user_track_listening_history utlh;

-- Get user's genre affinity profile
CREATE OR REPLACE VIEW v_user_genre_profile AS
SELECT 
  user_id,
  array_agg(
    json_build_object(
      'genre', genre,
      'affinity', affinity_score
    ) ORDER BY affinity_score DESC
  ) as genre_profile
FROM public.user_genre_affinity
GROUP BY user_id;

-- ============================================================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================================================
COMMENT ON TABLE public.user_track_listening_history IS 'Core listening data. Every track play is logged with engagement metrics (time listened, completion %).';
COMMENT ON TABLE public.user_track_preferences IS 'Explicit user feedback: likes (1), dislikes (-1), neutral (0). One preference per track per user.';
COMMENT ON TABLE public.track_content_features IS 'Content-based features for similarity matching. Includes genres, moods, audio features, and ML embeddings.';
COMMENT ON TABLE public.user_onboarding_preferences IS 'User preferences from onboarding: language, region, favorite genres. Used for cold-start recommendations.';
COMMENT ON TABLE public.user_recommendations_cache IS 'Pre-computed recommendations refreshed periodically. Improves query performance for recommendation endpoints.';
COMMENT ON COLUMN public.user_track_listening_history.completion_percentage IS 'Percentage of track heard (0-100). Key metric: high completion % = user liked the track.';
COMMENT ON COLUMN public.user_onboarding_preferences.randomness_percentage IS 'Percentage of recommendations that should be random/serendipitous. Default 15% prevents filter bubble.';
COMMENT ON COLUMN public.track_content_features.embedding IS 'JSON array of ML embeddings for semantic similarity. Example: [0.123, 0.456, ...]';
