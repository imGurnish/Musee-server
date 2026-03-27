const { supabase, supabaseAdmin } = require('../db/config');
const { isUUID, validateArtistRoles } = require('../utils/validators');

function client() { return supabaseAdmin || supabase; }
const table = 'track_artists';

async function addTrackArtist(track_id, artist_id, role = 'viewer') {
    if (!(isUUID(track_id) && isUUID(artist_id) && validateArtistRoles(role))) throw new Error('invalid fields');
    const { data, error } = await client().from(table).insert({ track_id, artist_id, role }).select('*').single();
    if (error) throw error;
    return data;
}

async function updateTrackArtistByPair(track_id, artist_id, role) {
    if (!(isUUID(track_id) && isUUID(artist_id) && validateArtistRoles(role))) throw new Error('invalid fields');
    const { data, error } = await client().from(table).update({ role }).eq('track_id', track_id).eq('artist_id', artist_id).select('*').maybeSingle();
    if (error) throw error;
    return data;
}

async function deleteTrackArtistByPair(track_id, artist_id) {
    if (!(isUUID(track_id) && isUUID(artist_id))) throw new Error('invalid fields');
    const { data, error } = await client().from(table).delete().eq('track_id', track_id).eq('artist_id', artist_id).select('track_artist_id').maybeSingle();
    if (error) throw error;
    return !!data;
}

async function listTrackArtists(track_id) {
    if (!isUUID(track_id)) throw new Error('track_id must be a UUID');
    const { data, error } = await client()
        .from(table)
        .select(`role, artists:artists!track_artists_artist_id_fkey(artist_id, users:users!artists_artist_id_fkey(name, avatar_url))`)
        .eq('track_id', track_id);
    if (error) throw error;
    return (data || []).map(ta => ({ artist_id: ta?.artists?.artist_id || null, role: ta?.role || null, name: ta?.artists?.users?.name || null, avatar_url: ta?.artists?.users?.avatar_url || null }));
}

module.exports = { addTrackArtist, updateTrackArtistByPair, deleteTrackArtistByPair, listTrackArtists };
