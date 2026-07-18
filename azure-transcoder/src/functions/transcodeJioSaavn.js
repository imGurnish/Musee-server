const { app } = require('@azure/functions');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { BlobServiceClient } = require('@azure/storage-blob');

// Set static ffmpeg path from package dependency
ffmpeg.setFfmpegPath(ffmpegPath);

app.http('transcodeJioSaavn', {
    methods: ['POST'],
    authLevel: 'function', // Requires function key in header (x-functions-key) or query string (?code=)
    handler: async (request, context) => {
        context.log('[Transcoder] Received HTTP request');

        let body;
        try {
            body = await request.json();
        } catch (e) {
            return {
                status: 400,
                jsonBody: { success: false, error: 'Invalid JSON body' }
            };
        }

        const { trackId, encryptedMediaUrl, resolvedUrl, mediaUrls } = body;

        if (!trackId) {
            return {
                status: 400,
                jsonBody: { success: false, error: 'Missing trackId' }
            };
        }

        if (!encryptedMediaUrl && !resolvedUrl && (!mediaUrls || mediaUrls.length === 0)) {
            return {
                status: 400,
                jsonBody: { success: false, error: 'Missing encryptedMediaUrl, resolvedUrl or mediaUrls' }
            };
        }

        const containerName = process.env.AZURE_STORAGE_CONTAINER || 'media';
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!connectionString) {
            console.error('[Transcoder] Missing AZURE_STORAGE_CONNECTION_STRING environment variable.');
            return {
                status: 500,
                jsonBody: { success: false, error: 'Azure storage connection string not configured on function server' }
            };
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerClient = blobServiceClient.getContainerClient(containerName);

        // Derive temp directory for processing
        const tmpDir = path.join(os.tmpdir(), `transcode_${trackId}_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        const infile = path.join(tmpDir, `input_${trackId}.media`);
        const hlsRootDir = path.join(tmpDir, 'hls');

        try {
            // 1. Resolve media source url list
            const urlsToTry = [];
            if (Array.isArray(mediaUrls) && mediaUrls.length > 0) {
                urlsToTry.push(...mediaUrls);
            } else if (resolvedUrl) {
                urlsToTry.push(resolvedUrl);
            } else if (encryptedMediaUrl) {
                context.log(`[Transcoder] Decrypting encryptedMediaUrl locally.`);
                const decrypted = decryptSaavnMediaUrl(encryptedMediaUrl);
                if (decrypted) {
                    urlsToTry.push(...buildBitrateVariantUrls(decrypted));
                }
            }

            if (urlsToTry.length === 0) {
                throw new Error('No valid download URLs resolved.');
            }

            // 2. Download from first working URL candidate
            let downloadResp = null;
            let lastError = null;
            let finalDownloadUrl = '';

            for (const url of urlsToTry) {
                try {
                    context.log(`[Transcoder] Attempting download from candidate: ${url}`);
                    downloadResp = await axios.get(url, {
                        responseType: 'stream',
                        headers: {
                            Accept: 'audio/*,*/*;q=0.8',
                            Referer: 'https://www.jiosaavn.com/',
                            Origin: 'https://www.jiosaavn.com',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        },
                        timeout: 30000
                    });
                    finalDownloadUrl = url;
                    break; // Success!
                } catch (err) {
                    lastError = err;
                    console.warn(`[Transcoder] Failed to download from candidate ${url}:`, err.message);
                }
            }

            if (!downloadResp) {
                throw lastError || new Error('All media URL candidates failed to download.');
            }

            context.log(`[Transcoder] Download starting from: ${finalDownloadUrl}`);
            const writer = fs.createWriteStream(infile);
            downloadResp.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            context.log(`[Transcoder] Download completed. Probing file.`);

            // Probe the downloaded file to verify its bitrate
            let fileBitrate = 128;
            try {
                const metadata = await new Promise((resolve, reject) => {
                    ffmpeg.ffprobe(infile, (err, meta) => err ? reject(err) : resolve(meta));
                });
                if (metadata?.format?.bit_rate) {
                    fileBitrate = Math.round(Number(metadata.format.bit_rate) / 1000);
                }
                context.log(`[Transcoder] Probed file bitrate: ${fileBitrate}kbps`);
            } catch (probeErr) {
                console.warn(`[Transcoder] Probing failed, defaulting to 128kbps:`, probeErr.message);
            }

            // 3. Generate HLS Variants
            fs.mkdirSync(hlsRootDir, { recursive: true });
            const HLS_VARIANTS = [96, 160, 320];

            context.log(`[Transcoder] Transcoding HLS variants: ${HLS_VARIANTS.join(',')}`);
            await Promise.all(HLS_VARIANTS.map(kb => generateHlsVariant(infile, hlsRootDir, kb)));

            // 4. Generate master playlist content
            const masterPath = path.join(hlsRootDir, 'master.m3u8');
            const entries = HLS_VARIANTS.map(kb => [
                `#EXT-X-STREAM-INF:BANDWIDTH=${kb * 1000 * 2},CODECS="mp4a.40.2"`,
                `v${kb}/index.m3u8`,
            ]).flat();
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-VERSION:3',
                '#EXT-X-INDEPENDENT-SEGMENTS',
                ...entries,
                ''
            ].join('\n');
            fs.writeFileSync(masterPath, masterContent, 'utf8');

            // 5. Upload files recursively to Azure Blob Storage
            context.log(`[Transcoder] Uploading transcoded assets to Azure Blob Storage container: ${containerName}`);
            const hlsPrefix = `hls/track_${trackId}`;
            await uploadDirToAzureBlob(containerClient, hlsRootDir, hlsPrefix);

            context.log(`[Transcoder] All files uploaded successfully.`);

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    trackId,
                    hlsMasterPath: `${hlsPrefix}/master.m3u8`,
                    bitrates: HLS_VARIANTS,
                    fileBitrate
                }
            };
        } catch (error) {
            console.error(`[Transcoder] Ingestion failed for track ${trackId}:`, error);
            return {
                status: 500,
                jsonBody: { success: false, error: error.message }
            };
        } finally {
            // Cleanup temp files
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch (_) {}
        }
    }
});

// Helper: Decrypt DES encrypted JioSaavn URLs
function decryptSaavnMediaUrl(encryptedMediaUrl) {
    if (!encryptedMediaUrl || typeof encryptedMediaUrl !== 'string') return null;
    try {
        const normalized = encryptedMediaUrl.trim().replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
        const encryptedBuffer = Buffer.from(padded, 'base64');

        const decipher = crypto.createDecipheriv('des-ecb', Buffer.from('38346591', 'utf8'), null);
        decipher.setAutoPadding(true);

        const decrypted = Buffer.concat([
            decipher.update(encryptedBuffer),
            decipher.final()
        ]).toString('utf8').trim();

        if (!decrypted) return null;
        return decrypted.startsWith('http') ? decrypted : `https://${decrypted}`;
    } catch (_) {
        return null;
    }
}

function buildBitrateVariantUrls(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return [];
    const variants = [];
    const bitrates = ['320', '160', '96'];
    for (const bitrate of bitrates) {
        const replaced = baseUrl.replace(/_(\d{2,3})\.mp4(\?.*)?$/i, `_${bitrate}.mp4$2`);
        variants.push(replaced);
    }
    return Array.from(new Set(variants));
}

// Helper: Transcode to HLS variant
function generateHlsVariant(infile, hlsRootDir, kbps) {
    const vDir = path.join(hlsRootDir, `v${kbps}`);
    fs.mkdirSync(vDir, { recursive: true });
    
    return new Promise((resolve, reject) => {
        ffmpeg(infile)
            .noVideo()
            .audioCodec('aac')
            .audioBitrate(`${kbps}k`)
            .audioChannels(2)
            .addOption('-ar', '48000')
            .format('hls')
            .outputOptions([
                '-hls_time 6',
                '-hls_playlist_type vod',
                '-hls_flags independent_segments',
                `-hls_segment_filename ${path.join(vDir, 'seg_%05d.ts').replace(/\\/g, '/')}`
            ])
            .output(path.join(vDir, 'index.m3u8'))
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
}

// Helper: Recursively upload directories to Azure Blob Storage
async function uploadDirToAzureBlob(containerClient, localDir, basePrefix) {
    const files = [];
    const stack = [localDir];
    
    while (stack.length) {
        const dir = stack.pop();
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                stack.push(full);
            } else {
                files.push(full);
            }
        }
    }

    const mime = require('mime-types');
    for (const file of files) {
        const rel = path.relative(localDir, file).replace(/\\/g, '/');
        const blobName = `${basePrefix}/${rel}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        let mimeType = mime.lookup(file) || 'application/octet-stream';
        if (file.endsWith('.m3u8')) {
            mimeType = 'application/vnd.apple.mpegurl';
        } else if (file.endsWith('.ts')) {
            mimeType = 'video/mp2t';
        }

        await blockBlobClient.uploadFile(file, {
            blobHTTPHeaders: { blobContentType: mimeType }
        });
    }
}
