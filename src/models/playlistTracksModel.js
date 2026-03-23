const { supabase, supabaseAdmin } = require('../db/config');
const { isUUID } = require('../utils/validators');

function client() { return supabaseAdmin || supabase; }
const table = 'playlist_tracks';

async function addPlaylistTrack(playlist_id, track_id, added_by = null) {
    if (!(isUUID(playlist_id) && isUUID(track_id))) throw new Error('invalid ids');
    // avoid duplicates: check existing
    const { data: exists, error: exErr } = await client()
        .from(table)
        .select('playlist_track_id')
        .eq('playlist_id', playlist_id)
        .eq('track_id', track_id)
        .maybeSingle();
    if (exErr) throw exErr;
    if (exists) return exists;

    const { data: last, error: lastErr } = await client()
        .from(table)
        .select('position')
        .eq('playlist_id', playlist_id)
        .order('position', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (lastErr) throw lastErr;

    const nextPosition = (last?.position || 0) + 1;
    const rowToInsert = { playlist_id, track_id, position: nextPosition };
    if (added_by && isUUID(added_by)) rowToInsert.added_by = added_by;

    const { data, error } = await client().from(table).insert(rowToInsert).select('*').single();
    if (error) throw error;
    return data;
}

async function removePlaylistTrack(playlist_id, track_id) {
    if (!(isUUID(playlist_id) && isUUID(track_id))) throw new Error('invalid ids');
    const { error } = await client().from(table).delete().eq('playlist_id', playlist_id).eq('track_id', track_id);
    if (error) throw error;
}

async function listPlaylistTracks(playlist_id) {
    if (!isUUID(playlist_id)) throw new Error('invalid id');
    const { data, error } = await client()
        .from(table)
        .select(`
            playlist_track_id,
            tracks:tracks!playlist_tracks_track_id_fkey(track_id, title, duration, created_at)
        `)
        .eq('playlist_id', playlist_id);
    if (error) throw error;
    return (data || []).map(r => r.tracks).filter(Boolean);
}

module.exports = { addPlaylistTrack, removePlaylistTrack, listPlaylistTracks };
