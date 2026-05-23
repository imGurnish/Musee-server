const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const { blobServiceClient, containerName, supabase, supabaseAdmin } = require('../../db/config');

const isDevelopment = process.env.NODE_ENV === 'development';

// In-memory cache for storage telemetry
let cachedStorageMetrics = null;
let isStorageRefreshing = false;
let lastStorageRefreshedAt = null;

const CACHE_FILE_PATH = path.join(process.cwd(), 'telemetry_storage_cache.json');

// Initialize cache from disk on startup
async function initStorageCache() {
    try {
        const data = await fs.readFile(CACHE_FILE_PATH, 'utf8');
        const parsed = JSON.parse(data);
        if (parsed && parsed.azure && parsed.supabaseStorage) {
            cachedStorageMetrics = parsed;
            if (parsed.lastRefreshedAt) {
                lastStorageRefreshedAt = new Date(parsed.lastRefreshedAt);
            }
            console.log('[Telemetry] Loaded storage metrics cache from disk successfully.');
            return;
        }
    } catch (err) {
        // Cache file doesn't exist or is invalid; ignore and populate placeholders
        console.log('[Telemetry] No valid disk cache found. Initializing storage placeholders.');
    }

    // Default placeholders to avoid client decoding/parsing crashes
    cachedStorageMetrics = {
        azure: {
            enabled: !!blobServiceClient,
            container: containerName || 'media',
            blobs: 0,
            bytes: 0,
            byPrefix: {
                hls: { count: 0, bytes: 0 },
                audio: { count: 0, bytes: 0 },
                other: { count: 0, bytes: 0 }
            },
            message: isDevelopment
                ? 'Telemetry scan is disabled in development mode.'
                : 'Initial telemetry scan queued in the background.'
        },
        supabaseStorage: {
            enabled: !!(supabaseAdmin && supabaseAdmin.storage),
            buckets: [],
            totals: { objects: 0, bytes: 0 },
            message: isDevelopment
                ? 'Telemetry scan is disabled in development mode.'
                : 'Initial telemetry scan queued in the background.'
        }
    };
}

// Call init on load
initStorageCache().catch(err => {
    console.error('[Telemetry] Failed to initialize storage cache:', err);
});

async function azureMetrics() {
    if (!blobServiceClient) return { enabled: false };
    const container = blobServiceClient.getContainerClient(containerName);
    console.log('[Telemetry] Scanning Azure Blob Storage...');
    const start = Date.now();
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
        
        if (totalCount % 10000 === 0) {
            console.log(`[Telemetry] Azure background scanner listed ${totalCount} blobs...`);
        }
    }
    
    console.log(`[Telemetry] Azure scan completed in ${Date.now() - start}ms. Total blobs: ${totalCount}`);
    const toNum = (n) => Number(n);
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
    console.log('[Telemetry] Scanning Supabase Storage buckets...');
    const start = Date.now();
    
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
                        // It's a file
                        totalCount += 1;
                        const sz = entry?.metadata?.size;
                        if (typeof sz === 'number') totalBytes += sz;
                    } else if (entry.name) {
                        // It's a folder/directory (id is null)
                        const folderPath = prefix ? `${prefix}/${entry.name}` : entry.name;
                        await walk(folderPath);
                    }
                }
                if (data.length < limit) break;
                offset += limit;
            }
        }
        
        try { await walk(''); } catch (walkErr) {
            console.error(`[Telemetry] Supabase walk error on bucket ${bucket.name}:`, walkErr);
        }
        return { bucket: bucket.name, objects: totalCount, bytes: totalBytes };
    }

    const results = [];
    for (const b of buckets || []) {
        results.push(await sumBucket(b));
    }
    
    const totals = results.reduce((acc, r) => ({ objects: acc.objects + r.objects, bytes: acc.bytes + r.bytes }), { objects: 0, bytes: 0 });
    console.log(`[Telemetry] Supabase Storage scan completed in ${Date.now() - start}ms.`);
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
    const counts = await Promise.all(tables.map(t => countTable(client, t)));
    return { tables: counts };
}

async function serverMetrics() {
    try {
        const platform = os.platform();
        const arch = os.arch();
        const release = os.release();
        const hostname = os.hostname();
        
        const cpus = os.cpus();
        const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown';
        const cpuCores = cpus.length;
        
        const hostTotal = os.totalmem();
        const hostFree = os.freemem();
        const hostUsed = hostTotal - hostFree;
        const hostUsagePct = hostTotal > 0 ? Number(((hostUsed / hostTotal) * 100).toFixed(2)) : 0;
        
        const memUsage = process.memoryUsage();
        
        const uptime = os.uptime();
        const processUptime = process.uptime();
        
        let disk = null;
        try {
            const stats = await fs.statfs(process.cwd());
            const total = Number(stats.blocks * stats.bsize);
            const free = Number(stats.bfree * stats.bsize);
            const used = total - free;
            const usagePct = total > 0 ? Number(((used / total) * 100).toFixed(2)) : 0;
            disk = {
                total,
                free,
                used,
                usagePct
            };
        } catch (diskErr) {
            // Quietly warning is fine, won't crash telemetry
        }
        
        return {
            platform,
            arch,
            release,
            hostname,
            cpuModel,
            cpuCores,
            uptime,
            processUptime,
            memory: {
                hostTotal,
                hostFree,
                hostUsed,
                hostUsagePct,
                processRss: memUsage.rss,
                processHeapTotal: memUsage.heapTotal,
                processHeapUsed: memUsage.heapUsed,
                processExternal: memUsage.external
            },
            disk
        };
    } catch (e) {
        return { error: e?.message || String(e) };
    }
}

// Background storage metrics refresher
async function refreshStorageMetrics() {
    if (isStorageRefreshing) return;
    isStorageRefreshing = true;
    console.log('[Telemetry] Starting background storage metrics scan...');
    const start = Date.now();
    try {
        const [azure, supabaseStorage] = await Promise.all([
            azureMetrics().catch(e => ({ enabled: false, error: e?.message || String(e) })),
            supabaseStorageMetrics().catch(e => ({ enabled: false, error: e?.message || String(e) }))
        ]);
        
        cachedStorageMetrics = {
            azure,
            supabaseStorage
        };
        lastStorageRefreshedAt = new Date();
        
        // Save cache to disk to survive server restarts
        const payloadToSave = {
            ...cachedStorageMetrics,
            lastRefreshedAt: lastStorageRefreshedAt.toISOString()
        };
        await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(payloadToSave, null, 2), 'utf8');
        console.log(`[Telemetry] Background storage metrics updated and saved to disk in ${Date.now() - start}ms`);
    } catch (err) {
        console.error('[Telemetry] Background storage metrics scan failed:', err);
    } finally {
        isStorageRefreshing = false;
    }
}

// GET /api/admin/metrics
async function getUsage(req, res) {
    const forceRefresh = req.query.refresh === 'true';
    
    if (forceRefresh && !isStorageRefreshing && !isDevelopment) {
        console.log('[Telemetry] Client triggered a manual storage metrics refresh...');
        refreshStorageMetrics(); // Run asynchronously in the background, don't await!
    }

    try {
        const start = Date.now();
        // Fetch fast metrics in parallel (takes ~50-150ms max)
        const [database, system] = await Promise.all([
            dbMetrics(),
            serverMetrics()
        ]);
        
        // Ensure azure and supabaseStorage are fully structured
        const responseData = {
            timestamp: new Date().toISOString(),
            azure: cachedStorageMetrics.azure,
            supabaseStorage: cachedStorageMetrics.supabaseStorage,
            database,
            system,
            isRefreshing: isStorageRefreshing,
            lastRefreshedAt: lastStorageRefreshedAt ? lastStorageRefreshedAt.toISOString() : null,
            env: {
                supabaseUrl: process.env.SUPABASE_URL || null,
                azureContainer: containerName || null,
            }
        };
        
        // console.log(`[Telemetry] Telemetry response served in ${Date.now() - start}ms`);
        return res.json(responseData);
    } catch (error) {
        console.error('[Telemetry] Error preparing telemetry response:', error);
        return res.status(500).json({
            error: 'Failed to retrieve system metrics',
            details: error?.message || String(error)
        });
    }
}

// Schedules
if (!isDevelopment) {
    setTimeout(refreshStorageMetrics, 5000); // 5s after startup to keep initial boot lightning fast
    setInterval(refreshStorageMetrics, 6 * 60 * 60 * 1000); // Refresh every 6 hours
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