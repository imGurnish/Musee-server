function requestOrigin(req) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = forwardedHost || req.get('host');
    const protocol = (forwardedProto || req.protocol || 'http').split(',')[0].trim();
    if (!host) return null;
    return `${protocol}://${host}`;
}

function toAbsoluteUrl(req, value) {
    if (typeof value !== 'string' || !value.trim()) return value;
    if (/^https?:\/\//i.test(value)) return value;
    const origin = requestOrigin(req);
    if (!origin) return value;
    const normalizedPath = value.startsWith('/') ? value : `/${value}`;
    return `${origin}${normalizedPath}`;
}

function withAbsoluteHlsUrls(req, track) {
    if (!track || typeof track !== 'object' || !track.hls || typeof track.hls !== 'object') return track;
    const variants = Array.isArray(track.hls.variants) ? track.hls.variants : [];
    return {
        ...track,
        hls: {
            ...track.hls,
            master: toAbsoluteUrl(req, track.hls.master),
            variants: variants.map((variant) => ({
                ...variant,
                url: toAbsoluteUrl(req, variant?.url),
            })),
        },
    };
}

function withAbsoluteHlsUrlsList(req, tracks) {
    if (!Array.isArray(tracks)) return tracks;
    return tracks.map((track) => withAbsoluteHlsUrls(req, track));
}

module.exports = {
    toAbsoluteUrl,
    withAbsoluteHlsUrls,
    withAbsoluteHlsUrlsList,
};
