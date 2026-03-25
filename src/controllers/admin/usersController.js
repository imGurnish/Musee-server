const createError = require('http-errors');
const {
    listUsers,
    getUser,
    createUser,
    updateUser,
    deleteUser,
    sanitizeUserInsert,
    getUserByEmail,
    getUsersByIds,
    deleteUsers,
} = require('../../models/userModel');
const { uploadUserAvatarToStorage, deleteUserAvatarFromStorage } = require('../../utils/supabaseStorage');
const { deleteAuthUser } = require('../../models/authUserModel');
const { isUUID } = require('../../utils/validators');

async function list(req, res) {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0); // zero-based
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listUsers({ limit, offset, q });
    res.json({ items, total, page, limit });
}

async function getOne(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid user id');
    const item = await getUser(id);
    if (!item) throw createError(404, 'User not found');
    res.json(item);
}

async function create(req, res) {
    // req.file may be provided by multer
    const payload = sanitizeUserInsert({ ...req.body });
    const existingUser = await getUserByEmail(payload.email);
    if (existingUser?.user_id) {
        throw createError(409, 'A user with this email already exists');
    }

    const user_final = await createUser(payload);

    // upload avatar if file present    
    if (req.file) {
        console.log("file exitst");
        const avatarPath = await uploadUserAvatarToStorage(user_final.user_id, req.file);
        console.log('Uploading avatar for new user:', avatarPath);
        if (avatarPath) {
            const updated = await updateUser(user_final.user_id, { avatar_url: avatarPath });
            return res.status(201).json(updated);
        }
    }
    res.status(201).json(user_final);
}

async function update(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid user id');
    const existing = await getUser(id);
    if (!existing) throw createError(404, 'User not found');
    const payload = { ...req.body };
    if (req.file) {
        const avatarPath = await uploadUserAvatarToStorage(id, req.file);
        if (avatarPath) payload.avatar_url = avatarPath;
    }
    const item = await updateUser(id, payload);
    res.json(item);
}

async function remove(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid user id');
    const user = await getUser(id);
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }
    await deleteUserAvatarFromStorage(id, user.avatar_url);

    // Best-effort auth delete for legacy users that also exist in auth.users.
    try { await deleteAuthUser(id); } catch (_) { }
    try { await deleteUser(id); } catch (_) { }

    res.status(204).send();
}

async function removeMany(req, res) {
    const idsInput = req.body?.ids;
    if (!Array.isArray(idsInput) || idsInput.length === 0) {
        throw createError(400, 'ids array is required');
    }

    const uniqueIds = [...new Set(idsInput.map((v) => String(v).trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
        throw createError(400, 'ids array is required');
    }
    if (!uniqueIds.every(isUUID)) {
        throw createError(400, 'all ids must be valid UUIDs');
    }

    const existingUsers = await getUsersByIds(uniqueIds);
    const existingById = new Map(existingUsers.map((u) => [u.user_id, u]));
    const foundIds = [...existingById.keys()];
    const missingIds = uniqueIds.filter((id) => !existingById.has(id));

    for (const user of existingUsers) {
        try { await deleteUserAvatarFromStorage(user.user_id, user.avatar_url); } catch (_) { }
        try { await deleteAuthUser(user.user_id); } catch (_) { }
    }

    const deleted = await deleteUsers(foundIds);

    res.json({
        requested: uniqueIds.length,
        deleted,
        missing_ids: missingIds,
    });
}

module.exports = { list, getOne, create, update, remove, removeMany };
