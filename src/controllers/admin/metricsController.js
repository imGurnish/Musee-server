const { blobServiceClient, containerName, supabase, supabaseAdmin } = require('../../db/config');

async function azureMetrics() {
    if (!blobServiceClient) return { enabled: false };
    const container = blobServiceClient.getContainerClient(containerName);
    let totalBytes = 0n;
    let totalCount = 0;
    let byPrefix = { hls: { bytes: 0n, count: 0 }, audio: { bytes: 0n, count: 0 }, other: { bytes: 0n, count: 0 } };
    for await (const blob of container.listBlobsFlat()) {
        const size = BigInt(blob.properties.contentLength || 0);
        totalBytes += size;
        totalCount += 1;
        const name = blob.name || '';
        if (name.startsWith('hls/')) { byPrefix.hls.bytes += size; byPrefix.hls.count += 1; }
        else if (name.startsWith('audio/')) { byPrefix.audio.bytes += size; byPrefix.audio.count += 1; }
        else { byPrefix.other.bytes += size; byPrefix.other.count += 1; }
    }
    const toNum = (n) => Number(n); // may overflow >2^53, but acceptable for dashboards
    return {
        enabled: true,
        container: containerName,
        blobs: totalCount,
        bytes: toNum(totalBytes),
        byPrefix: {
            hls: { count: byPrefix.hls.count, bytes: toNum(byPrefix.hls.bytes) },
            audio: { count: byPrefix.audio.count, bytes: toNum(byPrefix.audio.bytes) },
            other: { count: byPrefix.other.count, bytes: toNum(byPrefix.other.bytes) },
        }
    };
}

async function supabaseStorageMetrics() {
    const client = supabaseAdmin;
    if (!client || !client.storage) return { enabled: false };
    const { data: buckets, error } = await client.storage.listBuckets();
    if (error) return { enabled: true, error: error.message };

    async function sumBucket(bucket) {
        let totalBytes = 0;
        let totalCount = 0;
        async function walk(prefix = '') {
            let offset = 0;
            const limit = 1000;
            while (true) {
                const { data, error } = await client.storage.from(bucket.name).list(prefix, { limit, offset });
                if (error) break;
                if (!data || data.length === 0) break;
                for (const entry of data) {
                    if (entry.id) {
                        // file
                        totalCount += 1;
                        const sz = entry?.metadata?.size;
                        if (typeof sz === 'number') totalBytes += sz;
                    } else if (entry.name && entry.name.endsWith('/')) {
                        await walk(prefix ? `${prefix}${entry.name}` : entry.name);
                    }
                }
                if (data.length < limit) break;
                offset += limit;
            }
        }
        try { await walk(''); } catch { }
        return { bucket: bucket.name, objects: totalCount, bytes: totalBytes };
    }

    const results = [];
    for (const b of buckets || []) {
        results.push(await sumBucket(b));
    }
    const totals = results.reduce((acc, r) => ({ objects: acc.objects + r.objects, bytes: acc.bytes + r.bytes }), { objects: 0, bytes: 0 });
    return { enabled: true, buckets: results, totals };
}

async function countTable(client, table) {
    try {
        const { count, error } = await client.from(table).select('*', { count: 'exact', head: true });
        if (error) return { table, error: error.message };
        return { table, count };
    } catch (e) {
        return { table, error: e?.message || String(e) };
    }
}

async function dbMetrics() {
    const client = supabaseAdmin || supabase;
    const tables = ['users', 'artists', 'albums', 'tracks', 'playlists', 'followers', 'album_artists', 'track_artists', 'playlist_tracks'];
    const counts = [];
    for (const t of tables) counts.push(await countTable(client, t));
    return { tables: counts };
}

// GET /api/admin/metrics
async function getUsage(req, res) {
    const [azure, storage, db] = await Promise.all([
        azureMetrics().catch(e => ({ enabled: false, error: e?.message || String(e) })),
        supabaseStorageMetrics().catch(e => ({ enabled: false, error: e?.message || String(e) })),
        dbMetrics().catch(e => ({ error: e?.message || String(e) })),
    ]);
    res.json({
        timestamp: new Date().toISOString(),
        azure,
        supabaseStorage: storage,
        database: db,
        env: {
            supabaseUrl: process.env.SUPABASE_URL || null,
            azureContainer: containerName || null,
        }
    });
}

// GET /api/admin/metrics/engagement
async function getEngagementMetrics(req, res) {
    try {
        const client = supabaseAdmin || supabase;
        const { data, error } = await client.rpc('get_engagement_metrics');
        if (error) throw error;
        res.json({ timestamp: new Date().toISOString(), engagement: data });
    } catch (e) {
        console.error('Engagement metrics error:', e);
        res.status(500).json({ error: e?.message || 'Failed to get engagement metrics' });
    }
}

// POST /api/admin/metrics/refresh-trending
// Replaces pg_cron: call this from an external scheduler or manually
async function refreshTrending(req, res) {
    try {
        const client = supabaseAdmin || supabase;
        const results = [];

        // Refresh materialized views
        const views = ['mv_trending_tracks_7d', 'mv_trending_artists_30d'];
        for (const view of views) {
            const { error } = await client.rpc('refresh_materialized_view', { view_name: view });
            if (error) {
                results.push({ view, status: 'error', message: error.message });
            } else {
                results.push({ view, status: 'refreshed' });
            }
        }

        // Recalculate popularity scores
        const { error: popErr } = await client.rpc('recalculate_popularity_scores');
        if (popErr) {
            results.push({ task: 'popularity_scores', status: 'error', message: popErr.message });
        } else {
            results.push({ task: 'popularity_scores', status: 'recalculated' });
        }

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            results
        });
    } catch (e) {
        console.error('Refresh trending error:', e);
        res.status(500).json({ error: e?.message || 'Failed to refresh trending data' });
    }
}

module.exports = { getUsage, getEngagementMetrics, refreshTrending };