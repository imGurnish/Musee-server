const { blobServiceClient, containerName } = require('../../db/config');
const { getBlobSasUrl } = require('../../utils/azureSas');
const path = require('path');

if (!blobServiceClient) {
    console.warn('[streamingController] Azure Blob Storage not configured');
}

const containerClient = blobServiceClient ? blobServiceClient.getContainerClient(containerName) : null;

async function downloadText(blobPath) {
    const blobClient = containerClient.getBlobClient(blobPath);
    const dl = await blobClient.download();
    const chunks = [];
    for await (const chunk of dl.readableStreamBody) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

// GET /api/user/tracks/:id/hls/master.m3u8
// Returns rewritten master playlist with SAS URLs to variant playlists
async function getHlsMaster(req, res) {
    const { id } = req.params;
    if (!containerClient) return res.status(500).send('Storage not configured');

    const basePrefix = `hls/track_${id}`;
    const masterPath = `${basePrefix}/master.m3u8`;
    try {
        const text = await downloadText(masterPath);
        const lines = text.split(/\r?\n/);
        const out = lines.map((line) => {
            if (!line || line.startsWith('#')) return line;
            // line like v96/index.m3u8
            const variantRel = line.replace(/\\/g, '/');
            const variantBlob = `${basePrefix}/${variantRel}`;
            const sas = getBlobSasUrl(variantBlob);
            return sas;
        }).join('\n');
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(out);
    } catch (e) {
        console.error('getHlsMaster failed:', e?.message || e);
        return res.status(404).send('HLS master not found');
    }
}

// GET /api/user/tracks/:id/hls/v:bitrate/index.m3u8
// Returns variant playlist with SAS URLs to segment .ts files
async function getHlsVariant(req, res) {
    const { id, bitrate } = { id: req.params.id, bitrate: req.params.bitrate };
    if (!containerClient) return res.status(500).send('Storage not configured');

    const basePrefix = `hls/track_${id}`;
    const variantPrefix = `${basePrefix}/v${bitrate}`;
    const variantPath = `${variantPrefix}/index.m3u8`;
    try {
        const text = await downloadText(variantPath);
        const lines = text.split(/\r?\n/);
        const out = lines.map((line) => {
            if (!line || line.startsWith('#')) return line;
            // line like seg_00001.ts
            const segRel = line.replace(/\\/g, '/');
            const segBlob = `${variantPrefix}/${segRel}`;
            const sas = getBlobSasUrl(segBlob);
            return sas;
        }).join('\n');
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(out);
    } catch (e) {
        console.error('getHlsVariant failed:', e?.message || e);
        return res.status(404).send('HLS variant not found');
    }
}

module.exports = { getHlsMaster, getHlsVariant };
