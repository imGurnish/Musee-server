const createError = require('http-errors');
const { isUUID } = require('../../utils/validators');
const {
    isFollowing: isFollowingModel,
    followUser,
    unfollowUser,
    listFollowers,
    listFollowing,
} = require('../../models/followersModel');

function parsePagination(query) {
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const page = Math.max(0, Number(query.page) || 0);
    const offset = page * limit;
    return { limit, page, offset };
}

async function follow(req, res) {
    const targetId = req.params.id;
    const me = req.user && req.user.id;
    if (!me) throw createError(401, 'Unauthorized');
    if (!isUUID(targetId)) throw createError(400, 'invalid user id');

    try {
        await followUser(me, targetId);
        res.status(200).json({ ok: true, message: 'Following' });
    } catch (err) {
        const status = err.status || 500;
        res.status(status).json({ error: err.message || 'Failed to follow user' });
    }
}

async function unfollow(req, res) {
    const targetId = req.params.id;
    const me = req.user && req.user.id;
    if (!me) throw createError(401, 'Unauthorized');
    if (!isUUID(targetId)) throw createError(400, 'invalid user id');

    try {
        await unfollowUser(me, targetId);
        res.status(200).json({ ok: true, message: 'Unfollowed' });
    } catch (err) {
        const status = err.status || 500;
        res.status(status).json({ error: err.message || 'Failed to unfollow user' });
    }
}

async function myFollowers(req, res) {
    const me = req.user && req.user.id;
    if (!me) throw createError(401, 'Unauthorized');
    const { limit, page, offset } = parsePagination(req.query);
    const { items, total } = await listFollowers(me, { limit, offset });
    res.json({ items, total, page, limit });
}

async function myFollowing(req, res) {
    const me = req.user && req.user.id;
    if (!me) throw createError(401, 'Unauthorized');
    const { limit, page, offset } = parsePagination(req.query);
    const { items, total } = await listFollowing(me, { limit, offset });
    const type = (req.query.type || '').toLowerCase();
    // Optional client-side filter for recommendations: only artists
    const filtered = type === 'artist' ? items.filter(u => (u && u.user_type === 'artist')) : items;
    res.json({ items: filtered, total, page, limit });
}

async function status(req, res) {
    const targetId = req.params.id;
    const me = req.user && req.user.id;
    if (!me) throw createError(401, 'Unauthorized');
    if (!isUUID(targetId)) throw createError(400, 'invalid user id');
    const following = await isFollowingModel(me, targetId);
    res.json({ following });
}

module.exports = { follow, unfollow, myFollowers, myFollowing, status };
