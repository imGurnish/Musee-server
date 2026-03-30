const { generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');

const { containerName } = require('../db/config');

function parseConnString(connStr) {
    const out = {};
    if (!connStr) return out;
    connStr.split(';').forEach(kv => {
        const [k, v] = kv.split('=');
        if (k && v) out[k.trim()] = v.trim();
    });
    return out;
}

// Create a signed URL for a blob path relative to the configured container.
// blobPath example: 'audio/track_123_320k.mp3' or 'hls/track_123/master.m3u8'
function getBlobSasUrl(blobPath, expiresInSeconds = 3600) {
    const fromEnvConn = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const parsed = parseConnString(fromEnvConn);
    const accountName = process.env.AZURE_STORAGE_ACCOUNT || parsed.AccountName;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY || parsed.AccountKey;
    if (!accountName || !accountKey) {
        throw new Error('Azure Storage account credentials not configured for SAS (set AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_ACCOUNT_KEY or AZURE_STORAGE_CONNECTION_STRING).');
    }

    const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
    const startsOn = new Date(Date.now() - 60 * 1000); // skew
    const expiresOn = new Date(Date.now() + Math.max(60, expiresInSeconds) * 1000);
    const sas = generateBlobSASQueryParameters({
        containerName,
        blobName: blobPath,
        permissions: BlobSASPermissions.parse('r'),
        startsOn,
        expiresOn,
        protocol: 'https',
    }, sharedKeyCredential).toString();

    return `https://${accountName}.blob.core.windows.net/${containerName}/${blobPath}?${sas}`;
}

function getBlobSasUrlWithExpiry(blobPath, expiresInSeconds = 3600) {
    const safeExpirySeconds = Math.max(60, Number(expiresInSeconds) || 3600);
    const expiresAt = new Date(Date.now() + safeExpirySeconds * 1000).toISOString();
    const url = getBlobSasUrl(blobPath, safeExpirySeconds);
    return { url, expiresAt };
}

function isAbsoluteUrl(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u);
}

function getBlobPublicUrl(blobPath) {
    const fromEnvConn = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const parsed = parseConnString(fromEnvConn);
    const accountName = process.env.AZURE_STORAGE_ACCOUNT || parsed.AccountName;
    if (!accountName) {
        throw new Error('Azure Storage account not configured (AZURE_STORAGE_ACCOUNT or AZURE_STORAGE_CONNECTION_STRING)');
    }
    return `https://${accountName}.blob.core.windows.net/${containerName}/${blobPath}`;
}

module.exports = { getBlobSasUrl, getBlobSasUrlWithExpiry, isAbsoluteUrl, getBlobPublicUrl };
