-- ============================================================================
-- Migration 005: Recommendation Engine Fixes
-- ============================================================================
-- Fixes the "frozen trending / stale recommendations" problems by adding the
-- database functions the application already calls but that were never created,
-- plus new windowed-trending and similarity functions that make trending move
-- and recommendations track the user's listening history.
--
-- Safe to re-run: every function uses CREATE OR REPLACE.
-- Created: 2026-06-18
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. increment_track_play_count
-- ----------------------------------------------------------------------------
-- Atomically bumps tracks.play_count. Called from logTrackPlay on a *real*
-- play (not a quick skip). Without this, play_count never moved and trending
-- was permanently frozen on import-time values.
CREATE OR REPLACE FUNCTION public.increment_track_play_count(
  p_track_id uuid,
  p_increment integer DEFAULT 1
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.tracks
  SET play_count = GREATEST(0, COALESCE(play_count, 0) + p_increment)
  WHERE track_id = p_track_id;
$$;

-- ----------------------------------------------------------------------------
-- 2. get_user_genres_with_stats
-- ----------------------------------------------------------------------------
-- Per-genre engagement stats for a user, derived from listening history +
-- explicit preferences. Feeds calculateGenreAffinity().
CREATE OR REPLACE FUNCTION public.get_user_genres_with_stats(
  user_id_param uuid
)
RETURNS TABLE (
  genre text,
  likes bigint,
  dislikes bigint,
  avg_completion_percentage numeric,
  track_count bigint,
  total_listen_time_seconds bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH plays AS (
    SELECT
      h.track_id,
      h.completion_percentage,
      h.time_listened_seconds,
      g.genre
    FROM public.user_track_listening_history h
    JOIN public.track_content_features f ON f.track_id = h.track_id
    CROSS JOIN LATERAL unnest(f.genres) AS g(genre)
    WHERE h.user_id = user_id_param
  ),
  prefs AS (
    SELECT
      g.genre,
      p.preference
    FROM public.user_track_preferences p
    JOIN public.track_content_features f ON f.track_id = p.track_id
    CROSS JOIN LATERAL unnest(f.genres) AS g(genre)
    WHERE p.user_id = user_id_param
  )
  SELECT
    pl.genre,
    COALESCE((SELECT count(*) FROM prefs pr WHERE pr.genre = pl.genre AND pr.preference = 1), 0)  AS likes,
    COALESCE((SELECT count(*) FROM prefs pr WHERE pr.genre = pl.genre AND pr.preference = -1), 0) AS dislikes,
    ROUND(AVG(pl.completion_percentage), 2)                                                       AS avg_completion_percentage,
    COUNT(DISTINCT pl.track_id)                                                                   AS track_count,
    COALESCE(SUM(pl.time_listened_seconds), 0)::bigint                                            AS total_listen_time_seconds
  FROM plays pl
  GROUP BY pl.genre;
$$;

-- ----------------------------------------------------------------------------
-- 3. get_user_genre_affinity_profile
-- ----------------------------------------------------------------------------
-- The user's computed genre affinity (read model for discovery recs).
CREATE OR REPLACE FUNCTION public.get_user_genre_affinity_profile(
  user_id_param uuid
)
RETURNS TABLE (
  genre text,
  affinity_score numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT genre, affinity_score
  FROM public.user_genre_affinity
  WHERE user_id = user_id_param
  ORDER BY affinity_score DESC;
$$;

-- ----------------------------------------------------------------------------
-- 4. get_trending_in_user_genres
-- ----------------------------------------------------------------------------
-- Tracks that are trending *recently* within genres the user actually likes,
-- excluding what they've already heard and anything they disliked.
-- This is the personalized "trending" recommendation type.
CREATE OR REPLACE FUNCTION public.get_trending_in_user_genres(
  user_id_param uuid,
  days integer DEFAULT 7,
  min_affinity numeric DEFAULT 0.4
)
RETURNS TABLE (
  track_id uuid,
  trend_score numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH aff AS (
    SELECT genre
    FROM public.user_genre_affinity
    WHERE user_id = user_id_param
      AND affinity_score >= min_affinity
  ),
  genre_tracks AS (
    SELECT DISTINCT f.track_id
    FROM public.track_content_features f
    WHERE EXISTS (
      SELECT 1
      FROM unnest(f.genres) AS g(genre)
      JOIN aff ON aff.genre = g.genre
    )
  ),
  recent AS (
    SELECT
      h.track_id,
      SUM(
        (0.3 + 0.7 * (h.completion_percentage / 100.0))
        * exp(-extract(epoch FROM (now() - h.played_at)) / (days * 86400.0))
      ) AS score
    FROM public.user_track_listening_history h
    WHERE h.played_at > now() - make_interval(days => days)
      AND h.was_skipped = false
    GROUP BY h.track_id
  )
  SELECT
    gt.track_id,
    (COALESCE(r.score, 0) + ln(1 + COALESCE(t.play_count, 0)) * 0.1) AS trend_score
  FROM genre_tracks gt
  JOIN public.tracks t ON t.track_id = gt.track_id
  LEFT JOIN recent r ON r.track_id = gt.track_id
  LEFT JOIN public.user_track_preferences p
    ON p.track_id = gt.track_id AND p.user_id = user_id_param
  WHERE t.is_published = true
    AND COALESCE(p.preference, 0) >= 0
    AND NOT EXISTS (
      SELECT 1 FROM public.user_track_listening_history hh
      WHERE hh.user_id = user_id_param AND hh.track_id = gt.track_id
    )
  ORDER BY trend_score DESC, gt.track_id
  LIMIT 500;
$$;

-- ----------------------------------------------------------------------------
-- 5. get_trending_tracks  (GLOBAL, time-windowed)
-- ----------------------------------------------------------------------------
-- Real trending: recency-weighted recent plays (completion-weighted, skips
-- excluded) with a small all-time popularity floor. This replaces sorting by
-- the static play_count column, so the list actually moves over time.
CREATE OR REPLACE FUNCTION public.get_trending_tracks(
  p_days integer DEFAULT 7,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_languages text[] DEFAULT NULL
)
RETURNS TABLE (
  track_id uuid,
  trend_score numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH recent AS (
    SELECT
      h.track_id,
      SUM(
        (0.3 + 0.7 * (h.completion_percentage / 100.0))
        * exp(-extract(epoch FROM (now() - h.played_at)) / (p_days * 86400.0))
      ) AS score
    FROM public.user_track_listening_history h
    WHERE h.played_at > now() - make_interval(days => p_days)
      AND h.was_skipped = false
    GROUP BY h.track_id
  )
  SELECT
    t.track_id,
    (r.score + ln(1 + COALESCE(t.play_count, 0)) * 0.1) AS trend_score
  FROM recent r
  JOIN public.tracks t ON t.track_id = r.track_id
  WHERE t.is_published = true
    AND (p_languages IS NULL OR t.language_code = ANY(p_languages))
  ORDER BY trend_score DESC, t.track_id
  LIMIT p_limit OFFSET p_offset;
$$;

-- ----------------------------------------------------------------------------
-- 6. refresh_similar_tracks
-- ----------------------------------------------------------------------------
-- Populates track_content_features.similar_track_ids using genre overlap +
-- shared-artist co-occurrence. Run periodically (background job). Without this
-- the "similar_to_liked" recommendation type returned nothing.
CREATE OR REPLACE FUNCTION public.refresh_similar_tracks(
  p_limit integer DEFAULT 20
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  updated integer;
BEGIN
  -- Perform an optimized batch update of similar tracks using set-based joins
  -- instead of slow row-by-row array unnesting / intersection subqueries.
  WITH track_genres AS (
    SELECT track_id, unnest(genres) AS genre
    FROM public.track_content_features
  ),
  genre_pairs AS (
    SELECT 
      tg1.track_id AS tid, 
      tg2.track_id AS sid, 
      COUNT(*) AS shared_genre_count
    FROM track_genres tg1
    JOIN track_genres tg2 ON tg1.genre = tg2.genre AND tg1.track_id <> tg2.track_id
    GROUP BY tg1.track_id, tg2.track_id
  ),
  artist_pairs AS (
    SELECT 
      ta1.track_id AS tid, 
      ta2.track_id AS sid, 
      COUNT(*) AS shared_artist_count
    FROM public.track_artists ta1
    JOIN public.track_artists ta2 ON ta1.artist_id = ta2.artist_id AND ta1.track_id <> ta2.track_id
    GROUP BY ta1.track_id, ta2.track_id
  ),
  scored_pairs AS (
    SELECT
      gp.tid,
      gp.sid,
      (gp.shared_genre_count * 2 + COALESCE(ap.shared_artist_count, 0) * 3) AS score
    FROM genre_pairs gp
    LEFT JOIN artist_pairs ap ON gp.tid = ap.tid AND gp.sid = ap.sid
  ),
  ranked_pairs AS (
    SELECT
      tid,
      sid,
      row_number() OVER (PARTITION BY tid ORDER BY score DESC, sid) AS rn
    FROM scored_pairs
  ),
  agg AS (
    SELECT tid, array_agg(sid ORDER BY rn) AS sims
    FROM ranked_pairs
    WHERE rn <= p_limit
    GROUP BY tid
  )
  UPDATE public.track_content_features f
  SET similar_track_ids = COALESCE(agg.sims, '{}'::uuid[]),
      updated_at = now()
  FROM agg
  WHERE agg.tid = f.track_id;

  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END;
$$;

-- ----------------------------------------------------------------------------
-- Permissions: allow the API roles to call these functions.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.increment_track_play_count(uuid, integer) TO anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_user_genres_with_stats(uuid) TO anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_user_genre_affinity_profile(uuid) TO anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_trending_in_user_genres(uuid, integer, numeric) TO anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_trending_tracks(integer, integer, integer, text[]) TO anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.refresh_similar_tracks(integer) TO service_role';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Grant step skipped: %', SQLERRM;
END $$;
