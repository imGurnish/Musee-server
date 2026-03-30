const { supabase, supabaseAdmin, blobServiceClient, containerName } = require('../db/config');
const { listTrackAudios } = require('../models/trackAudiosModel');
const { deleteTrackVideoFromStorage } = require('./supabaseStorage');

function dbClient() {
    return supabaseAdmin || supabase;
}

function getContainerClient() {
    if (!blobServiceClient) return null;
    return blobServiceClient.getContainerClient(containerName);
}

function toBlobPath(pathOrUrl) {
    if (!pathOrUrl || typeof pathOrUrl !== 'string') return null;
    const trimmed = pathOrUrl.trim();
    if (!trimmed) return null;

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            const marker = `/${containerName}/`;
            const idx = parsed.pathname.indexOf(marker);
            if (idx >= 0) {
                return decodeURIComponent(parsed.pathname.substring(idx + marker.length));
            }
            return null;
        } catch (_) {
            return null;
        }
    }

    return trimmed.replace(/^\/+/, '');
}

async function deleteAzureBlobPath(pathOrUrl) {
    const blobPath = toBlobPath(pathOrUrl);
    if (!blobPath) return false;

    const containerClient = getContainerClient();
    if (!containerClient) return false;

    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
    const result = await blockBlobClient.deleteIfExists();
    return !!result?.succeeded;
}

async function deleteAzurePrefix(prefix) {
    const containerClient = getContainerClient();
    if (!containerClient) return 0;

    let deleted = 0;
    for await (const item of containerClient.listBlobsFlat({ prefix })) {
        const blockBlobClient = containerClient.getBlockBlobClient(item.name);
        const result = await blockBlobClient.deleteIfExists();
        if (result?.succeeded) deleted += 1;
    }
    return deleted;
}

async function cleanupSingleTrackBlobs({ trackId, videoUrl }) {
    const trackAudios = await listTrackAudios(trackId);
    for (const audio of trackAudios) {
        await deleteAzureBlobPath(audio.file_path);
    }

    await deleteAzurePrefix(`hls/track_${trackId}/`);

    if (videoUrl) {
        const removed = await deleteTrackVideoFromStorage(trackId, videoUrl);
        if (!removed) {
            throw new Error(`Failed to delete video blob for track ${trackId}`);
        }
    }
}

async function cleanupAlbumTrackBlobs(albumId) {
    const { data, error } = await dbClient()
        .from('tracks')
        .select('track_id, video_url')
        .eq('album_id', albumId);

    if (error) throw error;

    for (const track of data || []) {
        await cleanupSingleTrackBlobs({
            trackId: track.track_id,
            videoUrl: track.video_url,
        });
    }
}

module.exports = {
    cleanupSingleTrackBlobs,
    cleanupAlbumTrackBlobs,
};
