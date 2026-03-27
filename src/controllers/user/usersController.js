const createError = require('http-errors');
const { listUsersPublic, getUserPublic, getUser, updateUser, deleteUser } = require('../../models/userModel');
const { uploadUserAvatarToStorage, deleteUserAvatarFromStorage } = require('../../utils/supabaseStorage');
const { isUUID } = require('../../utils/validators');

function filterAllowedFields(payload) {
    // Whitelist fields that users can update about themselves
    const allowed = new Set(['name', 'settings']);
    const out = {};
    for (const key of Object.keys(payload || {})) {
        if (allowed.has(key)) out[key] = payload[key];
        else throw createError(403, 'invalid field ' + key);
    }
    return out;
}

async function list(req, res) {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0); // zero-based
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listUsersPublic({ limit, offset, q });
    res.json({ items, total, page, limit });
}

async function getOne(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid user id');
    const item = await getUserPublic(id);
    if (!item) throw createError(404, 'User not found');
    res.json(item);
}

async function getMe(req, res) {
    const user_info = await getUser(req.user.id);
    return res.json(user_info);
}

async function update(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid user id');
    // Only allow a user to update their own record
    if (!req.user || req.user.id !== id) {
        return res.status(403).json({ message: 'Forbidden' });
    }

    const body = filterAllowedFields({ ...req.body });

    const existing = await getUser(id);
    if (!existing) throw createError(404, 'User not found');

    const item = await updateUser(id, body);

    // Handle avatar upload separately
    if (req.file) {
        const avatarPath = await uploadUserAvatarToStorage(id, req.file);
        if (avatarPath) item.avatar_url = avatarPath;
        await updateUser(id, { avatar_url: avatarPath });
    }

    res.json(item);
}

async function remove(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid user id');
    if (!req.user || req.user.id !== id) {
        return res.status(403).json({ message: 'Forbidden' });
    }
    const user_info = await getUser(id);
    if (!user_info) {
        return res.status(404).json({ message: 'User not found' });
    }
    await deleteUserAvatarFromStorage(id, user_info.avatar_url);
    await deleteUser(id);
    res.status(204).send();
}

module.exports = { list, getOne, getMe, update, remove };
