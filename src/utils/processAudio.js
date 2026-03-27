const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { blobServiceClient, containerName } = require('../db/config');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');
const logger = require('./logger');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const containerClient = blobServiceClient ? blobServiceClient.getContainerClient(containerName) : null;

function parseEnvPositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

// Tuning/config (can be overridden via ENV)
const GEN_PROGRESSIVE = process.env.GENERATE_PROGRESSIVE !== '0'; // 1/true by default to preserve behavior
const HLS_VARIANTS = (process.env.GENERATE_HLS_VARIANTS || '96,160,320')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0);
const HLS_SEGMENT_SECONDS = parseEnvPositiveInt(process.env.HLS_SEGMENT_DURATION, 6, { min: 2, max: 30 });
const FFMPEG_THREADS = String(parseEnvPositiveInt(process.env.FFMPEG_THREADS, 4, { min: 1, max: 16 }));
const UPLOAD_CONCURRENCY = parseEnvPositiveInt(process.env.UPLOAD_CONCURRENCY, 12, { min: 1, max: 64 });

function ffprobe(filePath) {
    return new Promise((resolve, reject) => ffmpeg.ffprobe(filePath, (err, metadata) => (err ? reject(err) : resolve(metadata))));
}

function convertToOgg(inputPath, outputPath, bitrateKbps) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .noVideo()
            .audioCodec('libvorbis')
            .audioBitrate(`${bitrateKbps}k`)
            .addOption('-threads', FFMPEG_THREADS)
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject);
    });
}

function convertToMp3(inputPath, outputPath, bitrateKbps) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate(`${bitrateKbps}k`)
            .addOption('-threads', FFMPEG_THREADS)
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject);
    });
}

async function uploadToBlob(localPath, blobName) {
    if (!containerClient) throw new Error('Azure Blob Storage not configured');
    // ensure container exists (create if missing)
    try {
        await containerClient.createIfNotExists();
    } catch (e) {
        // ignore errors here, upload will surface actual problem
        console.warn('Could not create or verify container:', e?.message || e);
    }

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const ext = path.extname(localPath).toLowerCase();
    let mimeType = mime.lookup(localPath) || 'application/octet-stream';
    if (ext === '.m3u8') mimeType = 'application/vnd.apple.mpegurl';
    else if (ext === '.ts') mimeType = 'video/mp2t';
    await blockBlobClient.uploadFile(localPath, {
        blobHTTPHeaders: { blobContentType: mimeType },
    });
    // Return blob path (name) instead of absolute URL. We'll sign it when serving.
    return blockBlobClient.name;
}

function getAudioFileFromReq(req) {
    if (req.files && req.files.audio && req.files.audio.length) return req.files.audio[0];
    if (req.file) return req.file;
    return null;
}

// Helper: process audio buffer and upload variants to blob storage for a given trackId
async function processAudioBuffer(audioFile, trackId) {
    if (!audioFile) throw new Error('No audio file provided');
    if (!blobServiceClient) throw new Error('Azure Blob Storage not configured');

    logger.info(`[processAudio] Starting audio pipeline for track ${trackId}`);

    const tmpDir = path.join(os.tmpdir(), 'musee_audio');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const originalName = path.parse(audioFile.originalname || 'audio').name;
    const infile = path.join(tmpDir, `${uuidv4()}_${originalName}${path.extname(audioFile.originalname) || '.in'}`);
    const generatedLocalFiles = [];
    const hlsRootDir = path.join(tmpDir, `hls_${trackId}_${uuidv4()}`);

    function safeUnlink(filePath) {
        try {
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_) {
            // no-op
        }
    }

    function safeRemoveDir(dirPath) {
        try {
            if (dirPath && fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
        } catch (_) {
            // no-op
        }
    }

    try {

        // write buffer to temp file (multer memoryStorage)
        if (audioFile.buffer) {
            fs.writeFileSync(infile, audioFile.buffer);
        } else if (audioFile.path) {
            // disk storage
            fs.copyFileSync(audioFile.path, infile);
        } else {
            throw new Error('Unsupported audio file input');
        }

        const metadata = await ffprobe(infile);
        const bitrate = metadata?.format?.bit_rate ? Math.round(Number(metadata.format.bit_rate) / 1000) : null;
        if (!bitrate) throw new Error('Unable to determine audio bitrate');
        logger.info(`[processAudio] Input probed for track ${trackId}: bitrate=${bitrate}kbps`);

        // variants to generate (kbps)
        const variants = HLS_VARIANTS.length ? HLS_VARIANTS : [96, 160, 320];
        const generated = {};

        // create mp3 at original bitrate (optional toggle)
        if (GEN_PROGRESSIVE) {
            const mp3Ext = 'mp3';
            const mp3Filename = `track_${trackId}_${bitrate}k.${mp3Ext}`;
            const mp3Local = path.join(tmpDir, mp3Filename);
            generatedLocalFiles.push(mp3Local);
            await convertToMp3(infile, mp3Local, bitrate);
            const mp3Blob = `audio/${mp3Filename}`;
            const mp3Path = await uploadToBlob(mp3Local, mp3Blob);
            generated[`${bitrate}k_mp3`] = mp3Path;
            logger.info(`[processAudio] Progressive uploaded for track ${trackId}: ${mp3Path}`);
        }

        // OGG generation removed (keep only original MP3). Set GENERATE_PROGRESSIVE=0 to skip even MP3.

        // Generate HLS variants and master playlist
        fs.mkdirSync(hlsRootDir, { recursive: true });

        async function generateHlsVariant(kb) {
            const vDir = path.join(hlsRootDir, `v${kb}`);
            fs.mkdirSync(vDir, { recursive: true });
            const segPattern = path.join(vDir, 'seg_%05d.ts');
            const playlistPath = path.join(vDir, 'index.m3u8');
            await new Promise((resolve, reject) => {
                ffmpeg(infile)
                    .noVideo()
                    .audioCodec('aac')
                    .audioBitrate(`${kb}k`)
                    .audioChannels(2)
                    .addOption('-ar', '48000')
                    .addOption('-threads', FFMPEG_THREADS)
                    .format('hls')
                    .outputOptions([
                        `-hls_time ${HLS_SEGMENT_SECONDS}`,
                        '-hls_playlist_type vod',
                        '-hls_flags independent_segments',
                        `-hls_segment_filename ${segPattern.replace(/\\/g, '/')}`,
                    ])
                    .output(playlistPath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
        }
        // Generate HLS variants in parallel to utilize multiple cores
        logger.info(`[processAudio] Generating HLS variants for track ${trackId}: ${variants.join(',')}`);
        await Promise.all(variants.map(kb => generateHlsVariant(kb)));

        // Write master.m3u8
        const masterPath = path.join(hlsRootDir, 'master.m3u8');
        // derive BANDWIDTH approximately as bitrate * 1000 + overhead
        const entries = variants.map(kb => [
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

        // Upload HLS tree under hls/track_<trackId>/
        function listFilesRecursive(localDir) {
            const files = [];
            const stack = [localDir];
            while (stack.length) {
                const dir = stack.pop();
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const ent of entries) {
                    const full = path.join(dir, ent.name);
                    if (ent.isDirectory()) stack.push(full);
                    else files.push(full);
                }
            }
            return files;
        }
        async function uploadDir(localDir, baseBlobPrefix) {
            const files = listFilesRecursive(localDir);
            // simple concurrency limiter
            let i = 0;
            async function worker() {
                while (i < files.length) {
                    const idx = i++;
                    const local = files[idx];
                    const rel = path.relative(hlsRootDir, local).replace(/\\/g, '/');
                    const blobName = `${baseBlobPrefix}/${rel}`;
                    await uploadToBlob(local, blobName);
                }
            }
            const conc = Math.max(1, UPLOAD_CONCURRENCY);
            await Promise.all(Array.from({ length: conc }, () => worker()));
        }
        const hlsPrefix = `hls/track_${trackId}`;
        await uploadDir(hlsRootDir, hlsPrefix);
        logger.info(`[processAudio] HLS uploaded for track ${trackId}: ${hlsPrefix}/master.m3u8`);

        logger.info(`[processAudio] Completed audio pipeline for track ${trackId}`);
        return { bitrate, files: generated, hls: { master: `${hlsPrefix}/master.m3u8` } };
    } finally {
        safeUnlink(infile);
        generatedLocalFiles.forEach(safeUnlink);
        safeRemoveDir(hlsRootDir);
    }
}

module.exports = { processAudioBuffer };
