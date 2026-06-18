/**
 * One-off diagnostic for the recommendation / trending / auto-next pipeline.
 * Run:  node tools/diagnoseRecs.js
 *
 * It only READS data (plus probes RPCs with harmless args). Nothing is written.
 * Paste the full output back so we know exactly what to build vs. wire up.
 */
require('dotenv').config();
const { supabaseAdmin, supabase } = require('../src/db/config');

const db = supabaseAdmin || supabase;

async function tableCount(table, filter) {
  try {
    let q = db.from(table).select('*', { count: 'exact', head: true });
    if (filter) q = filter(q);
    const { count, error } = await q;
    if (error) return `ERROR: ${error.message}`;
    return count;
  } catch (e) {
    return `EXC: ${e.message}`;
  }
}

async function probeRpc(name, args) {
  try {
    const { error } = await db.rpc(name, args);
    if (error) {
      // 42883 = function does not exist
      const missing = /does not exist|could not find|PGRST202|not find the function/i.test(
        `${error.message} ${error.code || ''} ${error.hint || ''}`,
      );
      return missing ? 'MISSING' : `EXISTS (call errored: ${error.message})`;
    }
    return 'EXISTS (ok)';
  } catch (e) {
    return `EXC: ${e.message}`;
  }
}

async function main() {
  console.log('=== MUSEE RECOMMENDATION DIAGNOSTIC ===\n');

  // Grab a real user id to make RPC probes meaningful
  const { data: someUser } = await db
    .from('user_track_listening_history')
    .select('user_id')
    .limit(1)
    .maybeSingle();
  const uid = someUser?.user_id || '00000000-0000-0000-0000-000000000000';
  console.log(`Sample user_id for RPC probes: ${uid}\n`);

  console.log('--- RPC functions the code depends on ---');
  const rpcs = [
    ['get_user_genre_affinity_profile', { user_id_param: uid }],
    ['get_user_genres_with_stats', { user_id_param: uid }],
    ['get_trending_in_user_genres', { user_id_param: uid, days: 7, min_affinity: 0.4 }],
    ['upsert_user_album_listening', { p_user_id: uid, p_album_id: uid, p_time_seconds: 0 }],
    ['upsert_user_artist_listening', { p_user_id: uid, p_artist_id: uid, p_time_seconds: 0 }],
    ['upsert_user_playlist_listening', { p_user_id: uid, p_playlist_id: uid, p_time_seconds: 0 }],
    ['increment_track_play_count', { p_track_id: uid, p_increment: 0 }],
  ];
  for (const [name, args] of rpcs) {
    console.log(`  ${name.padEnd(36)} -> ${await probeRpc(name, args)}`);
  }

  console.log('\n--- Table row counts ---');
  const tables = [
    'tracks',
    'user_track_listening_history',
    'user_track_preferences',
    'track_content_features',
    'user_genre_affinity',
    'user_mood_affinity',
    'user_onboarding_preferences',
    'user_recommendations_cache',
    'user_artist_listening_history',
  ];
  for (const t of tables) {
    console.log(`  ${t.padEnd(34)} -> ${await tableCount(t)}`);
  }

  console.log('\n--- track_content_features population ---');
  console.log(`  rows with non-empty genres        -> ${await tableCount('track_content_features', q => q.not('genres', 'eq', '{}'))}`);
  console.log(`  rows with non-empty mood          -> ${await tableCount('track_content_features', q => q.not('mood', 'eq', '{}'))}`);
  console.log(`  rows with non-empty similar_track -> ${await tableCount('track_content_features', q => q.not('similar_track_ids', 'eq', '{}'))}`);

  console.log('\n--- play_count distribution on tracks ---');
  console.log(`  published tracks                  -> ${await tableCount('tracks', q => q.eq('is_published', true))}`);
  console.log(`  play_count = 0                    -> ${await tableCount('tracks', q => q.eq('is_published', true).eq('play_count', 0))}`);
  console.log(`  play_count > 0                    -> ${await tableCount('tracks', q => q.eq('is_published', true).gt('play_count', 0))}`);
  const { data: topPlay } = await db
    .from('tracks')
    .select('track_id, title, play_count, created_at')
    .eq('is_published', true)
    .order('play_count', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(10);
  console.log('  current trending top-10 (play_count desc):');
  (topPlay || []).forEach((t, i) =>
    console.log(`    ${String(i + 1).padStart(2)}. pc=${String(t.play_count).padStart(6)}  ${t.title}`),
  );

  console.log('\n--- listening history recency ---');
  const since7 = new Date(Date.now() - 7 * 864e5).toISOString();
  console.log(`  plays in last 7 days              -> ${await tableCount('user_track_listening_history', q => q.gt('played_at', since7))}`);

  console.log('\n=== DONE ===');
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
