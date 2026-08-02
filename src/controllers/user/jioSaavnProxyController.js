/**
 * JioSaavn Proxy Controller
 *
 * Provides a server-side proxy for JioSaavn API calls.
 * This is intended for web clients that cannot make direct on-device
 * requests to JioSaavn (e.g., due to CORS or region restrictions).
 *
 * Native clients (Android, Linux, Windows) should call JioSaavn directly
 * on-device, as they are already in India and do not need this proxy.
 *
 * Route: GET /api/user/jiosaavn/proxy
 * Auth:  Requires valid user JWT (authUser middleware)
 *
 * All query parameters are forwarded verbatim to JioSaavn's API,
 * so the client constructs the full param set (__call, _format, etc.)
 * and the server injects the required Indian locale cookies & headers.
 */

const axios = require('axios');
const logger = require('../../utils/logger');

// These are the minimum params JioSaavn needs to serve Indian catalogue
// regardless of the server's IP address.
// - cc=in          → country code India
// - _marker=0      → disables geo-redirect
// - ctx=web6dot0   → web context that unlocks full Indian library
const INDIA_PARAMS = {
  cc: 'in',
  _marker: '0',
  ctx: 'web6dot0',
};

// Cookie that tells JioSaavn the user's preferred language and region.
// `DL=english` is the language preference; `ct=IN` pins country to India.
const INDIA_COOKIES = 'DL=english; ct=IN; L=english';

/**
 * Proxy a JioSaavn API request from a web client.
 *
 * The client passes all JioSaavn params as query string parameters.
 * The server injects Indian locale headers and forwards the request.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function proxyJioSaavn(req, res) {
  try {
    // Merge client params with forced India params.
    // Client params take precedence except for the India-specific ones,
    // which we always override to guarantee Indian catalogue.
    const params = {
      ...req.query,
      ...INDIA_PARAMS,
    };

    logger.info(`[JioSaavnProxy] Forwarding call: ${params.__call || '(unknown)'}`);

    const response = await axios.get('https://www.jiosaavn.com/api.php', {
      params,
      timeout: 15000,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': 'https://www.jiosaavn.com/',
        'Origin': 'https://www.jiosaavn.com',
        'Cookie': INDIA_COOKIES,
      },
    });

    let data = response.data;
    // JioSaavn sometimes returns a JSON-encoded string instead of parsed JSON.
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (_) {
        // Keep the raw string if it can't be parsed.
      }
    }

    logger.info(`[JioSaavnProxy] Success: ${params.__call || '(unknown)'}`);
    return res.status(200).json(data);
  } catch (err) {
    const status = err?.response?.status;
    logger.error(`[JioSaavnProxy] Request failed: ${err.message}`);

    if (status === 429) {
      return res.status(429).json({ error: 'JioSaavn rate limit exceeded. Please try again shortly.' });
    }

    if (status >= 400 && status < 500) {
      return res.status(502).json({ error: 'JioSaavn returned a client error.', upstream_status: status });
    }

    return res.status(502).json({ error: 'Failed to proxy JioSaavn request.', detail: err.message });
  }
}

module.exports = { proxyJioSaavn };
