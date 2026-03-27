const { supabase, supabaseAdmin } = require('../db/config');
const { isUUID, validateArtistRoles, } = require('../utils/validators');
const table = 'album_artists';

function client() {
    // Fallback to public client when service role is not configured
    return supabaseAdmin || supabase;
}

async function createAlbumArtist(album_id, artist_id, role) {
    if (!(isUUID(album_id) && isUUID(artist_id) && validateArtistRoles(role))) throw new Error('invalid fields');
    const { data, error } = await client().from(table).insert({ 'album_id': album_id, 'artist_id': artist_id, 'role': role }).select('*').single();
    if (error) throw error;
    return data;
}

async function updateAlbumArtist(id, role) {
    if (!validateArtistRoles(role)) throw new Error('invalid role');
    const { data, error } = await client().from(table).update({ 'role': role }).eq('album_artist_id', id).select('*').single();
    if (error) throw error;
    return data;
}

async function deleteAlbumArtist(id) {
    const { error } = await client().from(table).delete().eq('album_artist_id', id);
    if (error) throw error;
}

async function getAlbumArtistByPair(album_id, artist_id) {
    if (!(isUUID(album_id) && isUUID(artist_id))) throw new Error('invalid fields');
    const { data, error } = await client().from(table).select('*').eq('album_id', album_id).eq('artist_id', artist_id).maybeSingle();
    if (error) throw error;
    return data;
}

async function updateAlbumArtistByPair(album_id, artist_id, role) {
    if (!(isUUID(album_id) && isUUID(artist_id) && validateArtistRoles(role))) throw new Error('invalid fields');
    const { data, error } = await client().from(table).update({ role }).eq('album_id', album_id).eq('artist_id', artist_id).select('*').maybeSingle();
    if (error) throw error;
    return data;
}

async function deleteAlbumArtistByPair(album_id, artist_id) {
    if (!(isUUID(album_id) && isUUID(artist_id))) throw new Error('invalid fields');
    const { data, error } = await client().from(table).delete().eq('album_id', album_id).eq('artist_id', artist_id).select('album_artist_id').maybeSingle();
    if (error) throw error;
    return !!data;
}

module.exports = { createAlbumArtist, updateAlbumArtist, deleteAlbumArtist, getAlbumArtistByPair, updateAlbumArtistByPair, deleteAlbumArtistByPair };
