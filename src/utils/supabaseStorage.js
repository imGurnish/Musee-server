const { supabaseAdmin } = require('../db/config');
const mime = require('mime-types');

const AVATAR_BUCKET = process.env.SUPABASE_AVATAR_BUCKET || 'avatars';
const COVERS_BUCKET = process.env.SUPABASE_COVERS_BUCKET || 'covers';
const VIDEOS_BUCKET = process.env.SUPABASE_VIDEOS_BUCKET || 'videos';

async function uploadToSupabaseStoragePublic(bucket, path, file) {
    if (!file) return null;
    const client = supabaseAdmin;
    if (!client || !client.storage) return null;
    try {
        // upload buffer directly; upsert true to replace existing avatar
        const { error: upErr } = await client.storage.from(bucket).upload(path, file.buffer, { contentType: file.mimetype, upsert: true });
        if (upErr) {
            console.warn('Supabase storage upload error:', upErr.message || upErr);
            return null;
        }

        // Try public URL first (different supabase-js versions return either data.publicUrl or publicURL)
        const publicResp = client.storage.from(bucket).getPublicUrl(path);
        const publicData = publicResp?.data || publicResp;
        const publicUrl = publicData?.publicUrl || publicData?.publicURL;
        if (publicUrl) return publicUrl;
        throw new Error('Could not retrieve public URL after upload');
    } catch (e) {
        console.warn('Avatar upload failed:', e?.message || e);
        return null;
    }
}

async function uploadUserAvatarToStorage(userId, file) {
    const ext = mime.extension(file.mimetype) || 'jpg';
    const path = `users/${userId}.${ext}`;
    return await uploadToSupabaseStoragePublic(AVATAR_BUCKET, path, file);
}

async function uploadArtistCoverToStorage(artistId, file) {
    const ext = mime.extension(file.mimetype) || 'jpg';
    const path = `artists/${artistId}.${ext}`;
    return await uploadToSupabaseStoragePublic(COVERS_BUCKET, path, file);
}

async function uploadTrackCoverToStorage(trackId, file) {
    const ext = mime.extension(file.mimetype) || 'jpg';
    const path = `tracks/${trackId}.${ext}`;
    return await uploadToSupabaseStoragePublic(COVERS_BUCKET, path, file);
}

async function uploadTrackVideoToStorage(trackId, file) {
    const ext = mime.extension(file.mimetype) || 'mp4';
    const path = `tracks/${trackId}.${ext}`;
    return await uploadToSupabaseStoragePublic(VIDEOS_BUCKET, path, file);
}

async function uploadAlbumCoverToStorage(albumId, file) {
    const ext = mime.extension(file.mimetype) || 'jpg';
    const path = `albums/${albumId}.${ext}`;
    return await uploadToSupabaseStoragePublic(COVERS_BUCKET, path, file);
}

async function uploadPlaylistCoverToStorage(playlistId, file) {
    const ext = mime.extension(file.mimetype) || 'jpg';
    const path = `playlists/${playlistId}.${ext}`;
    return await uploadToSupabaseStoragePublic(COVERS_BUCKET, path, file);
}

async function deleteFromSupabaseStorage(bucket, path) {
    const client = supabaseAdmin;
    if (!client || !client.storage) return false;
    try {
        const { error: delErr } = await client.storage.from(bucket).remove([path]);
        if (delErr) {
            console.warn('Supabase storage delete error:', delErr.message || delErr);
            return false;
        }
        return true;
    }
    catch (e) {
        console.warn('Storage delete failed:', e?.message || e);
        return false;
    }
}

async function deleteUserAvatarFromStorage(userId, avatarUrl) {
    if (!avatarUrl || typeof avatarUrl !== 'string') return false;
    const clean = avatarUrl.split('?')[0];
    const ext = clean.split('.').pop();
    const path = `users/${userId}.${ext}`;
    return await deleteFromSupabaseStorage(AVATAR_BUCKET, path);
}

async function deleteArtistCoverFromStorage(artistId, coverUrl) {
    if (!coverUrl || typeof coverUrl !== 'string') return false;
    const clean = coverUrl.split('?')[0];
    const ext = clean.split('.').pop();
    const path = `artists/${artistId}.${ext}`;
    return await deleteFromSupabaseStorage(COVERS_BUCKET, path);
}

async function deleteTrackCoverFromStorage(trackId, coverUrl) {
    if (!coverUrl || typeof coverUrl !== 'string') return false;
    const clean = coverUrl.split('?')[0];
    const ext = clean.split('.').pop();
    const path = `tracks/${trackId}.${ext}`;
    return await deleteFromSupabaseStorage(COVERS_BUCKET, path);
}

async function deleteTrackVideoFromStorage(trackId, videoUrl) {
    if (!videoUrl || typeof videoUrl !== 'string') return false;
    const clean = videoUrl.split('?')[0];
    const ext = clean.split('.').pop();
    const path = `tracks/${trackId}.${ext}`;
    return await deleteFromSupabaseStorage(VIDEOS_BUCKET, path);
}

async function deleteAlbumCoverFromStorage(albumId, coverUrl) {
    if (!coverUrl || typeof coverUrl !== 'string') return false;
    const clean = coverUrl.split('?')[0];
    const ext = clean.split('.').pop();
    const path = `albums/${albumId}.${ext}`;
    return await deleteFromSupabaseStorage(COVERS_BUCKET, path);
}

async function deletePlaylistCoverFromStorage(playlistId, coverUrl) {
    if (!coverUrl || typeof coverUrl !== 'string') return false;
    const clean = coverUrl.split('?')[0];
    const ext = clean.split('.').pop();
    const path = `playlists/${playlistId}.${ext}`;
    return await deleteFromSupabaseStorage(COVERS_BUCKET, path);
}

module.exports = { uploadUserAvatarToStorage, uploadArtistCoverToStorage, uploadTrackCoverToStorage, uploadTrackVideoToStorage, uploadAlbumCoverToStorage, uploadPlaylistCoverToStorage, deleteFromSupabaseStorage, deleteUserAvatarFromStorage, deleteArtistCoverFromStorage, deleteTrackCoverFromStorage, deleteTrackVideoFromStorage, deleteAlbumCoverFromStorage, deletePlaylistCoverFromStorage };
