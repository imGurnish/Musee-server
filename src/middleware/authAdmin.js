const { supabaseAdmin, supabase } = require('../db/config');

// Middleware to authenticate a user via a Bearer token (Supabase access token).
// Uses the Supabase v2 auth API: auth.getUser(token)
// Falls back to the public client if a service-role client isn't configured.
module.exports = async function authAdmin(req, res, next) {
    let token = '';
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (authHeader) {
        const parts = authHeader.split(' ');
        token = parts.length === 2 ? parts[1] : parts[0];
    } else if (req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: 'No authorization token provided' });
    }

    const client = supabaseAdmin || supabase;
    if (!client) {
        console.error('Supabase client is not configured');
        return res.status(500).json({ error: 'Authentication service unavailable' });
    }

    try {
        // supabase-js v2: auth.getUser(token) -> { data: { user }, error }
        const result = await client.auth.getUser(token);
        // result shape: { data: { user: { id, ... } }, error }
        if (result.error || !result.data || !result.data.user) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        // check if user is admin
        const user_details = await supabaseAdmin.from('users').select('*').eq('user_id', result.data.user.id).maybeSingle();

        if (!user_details.data || user_details.data.user_type !== 'admin') {
            //console.log(user_details);
            return res.status(403).json({ message: 'Forbidden' });
        }

        req.user = result.data.user;
        // useful for debugging during development
        console.log('Authenticated user:', req.user.id);
        return next();
    } catch (err) {
        console.error('Error verifying token with Supabase:', err && err.message ? err.message : err);
        return res.status(401).json({ message: 'Unauthorized' });
    }
};
