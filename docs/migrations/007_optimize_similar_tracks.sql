-- Migration 007: Optimize Similar Tracks Function
-- Optimizes public.refresh_similar_tracks to prevent statement timeouts on large datasets
-- by replacing row-by-row array intersections with highly efficient set-based joins.

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

GRANT EXECUTE ON FUNCTION public.refresh_similar_tracks(integer) TO service_role;
