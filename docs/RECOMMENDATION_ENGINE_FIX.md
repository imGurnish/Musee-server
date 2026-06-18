# Recommendation Engine Fix — Runbook

This change fixes three problems:

1. **Trending was frozen.** `tracks.play_count` was set once at import and never
   incremented, and trending sorted by that static column. Now real plays bump it
   (`increment_track_play_count`) and trending uses a recency-weighted window
   (`get_trending_tracks`) so the list moves over time.
2. **Recommendations never tracked taste.** The discovery/trending RPCs the code
   called did not exist, genre affinity was never computed (no scheduler), and the
   genre filters used `contains` (match ALL) instead of `overlaps` (match ANY).
3. **Auto-next was random.** Queue fill now seeds from the current track's
   similar tracks + the user's affinity genres before falling back to random.

## What changed in code
- `docs/migrations/005_recommendation_engine_fixes.sql` — new DB functions.
- `src/controllers/listeningHistoryController.js` — increment play_count on real
  plays; extracted `recomputeGenreAffinity()`; `overlaps` instead of `contains`;
  aligned cache TTL (6h).
- `src/models/trackModel.js` — `listWindowedTrendingTracksUser()` (RPC + fallback).
- `src/controllers/user/dashboardController.js` — trending uses the windowed model.
- `src/models/recommendationModel.js` — `getAutoNextTrackIds()` and helpers.
- `src/controllers/user/queueController.js` — personalized queue fill.
- `src/jobs/scheduler.js` + `src/index.js` — background affinity / similarity /
  cache-cleanup jobs.

## Step 1 — Apply the migration (REQUIRED, manual)
The app uses the Supabase API only (no direct Postgres connection), so DDL must be
run in the **Supabase Dashboard → SQL Editor**. Paste the full contents of:

    docs/migrations/005_recommendation_engine_fixes.sql

and run it. It is idempotent (CREATE OR REPLACE) — safe to re-run.

## Step 2 — Verify the functions exist
    node tools/diagnoseRecs.js

All four MISSING functions should now read `EXISTS (ok)`.

## Step 3 — Build the initial data
Either restart the API (the scheduler builds the similarity graph ~30s after boot
and refreshes affinity hourly), or trigger manually:

- Similarity graph: runs automatically on boot, or call `refresh_similar_tracks()`
  in the SQL editor: `SELECT public.refresh_similar_tracks(20);`
- Genre affinity for a user (admin): `POST /api/admin/listening/calculate-affinity/:userId`

After Step 3, re-run `node tools/diagnoseRecs.js` — `track_content_features` should
show non-zero `similar_track_ids`, and `user_genre_affinity` should be > 0.

## Scheduler config (env, optional)
- `ENABLE_SCHEDULER=false` — disable background jobs on this instance (set on all
  but one instance if you run multiple API replicas).
- `AFFINITY_REFRESH_MINUTES` (default 60)
- `SIMILAR_REFRESH_MINUTES` (default 360)
- `CACHE_CLEANUP_MINUTES` (default 60)

## Notes / future work
- `track_content_features.mood` is empty for all tracks, so `mood_based`
  recommendations stay empty until a mood data source is populated. Genre-based
  discovery + similarity do not depend on mood.
- `refresh_similar_tracks` is a self-join over genre overlap; fine for the current
  catalog (~2.3k tracks). If the catalog grows large, switch to embeddings.
