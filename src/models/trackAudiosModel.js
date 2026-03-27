const { supabase, supabaseAdmin } = require('../db/config');
const { isUUID, validateAudioExts } = require('../utils/validators');

function client() { return supabaseAdmin || supabase; }
const table = 'track_assets';

async function addTrackAudio(track_id, ext, bitrate, path) {
    if (!isUUID(track_id)) throw new Error('track_id must be a UUID');
    if (!validateAudioExts(ext)) throw new Error('Invalid audio ext');
    const br = Number.parseInt(bitrate, 10);
    if (!Number.isFinite(br) || br <= 0) throw new Error('Invalid bitrate');
    if (typeof path !== 'string' || !path.trim()) throw new Error('Invalid path');
    const { data, error } = await client().from(table).insert({
        track_id,
        asset_type: 'audio_progressive',
        ext,
        bitrate_kbps: br,
        file_path: path,
    }).select('*').single();
    if (error) throw error;
    return data;
}

async function listTrackAudios(track_id) {
    if (!isUUID(track_id)) throw new Error('track_id must be a UUID');
    const { data, error } = await client().from(table)
        .select('*')
        .eq('track_id', track_id)
        .eq('asset_type', 'audio_progressive')
        .order('bitrate_kbps', { ascending: true });
    if (error) throw error;
    return data || [];
}

async function deleteAudiosForTrack(track_id) {
    if (!isUUID(track_id)) throw new Error('track_id must be a UUID');
    const { error } = await client().from(table).delete().eq('track_id', track_id).eq('asset_type', 'audio_progressive');
    if (error) throw error;
}

module.exports = { addTrackAudio, listTrackAudios, deleteAudiosForTrack };
