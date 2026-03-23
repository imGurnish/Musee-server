const createError = require('http-errors');
const { listUsers, getUser, createUser, updateUser, deleteUser, sanitizeUserInsert } = require('../../models/userModel');
const { uploadUserAvatarToStorage, deleteUserAvatarFromStorage } = require('../../utils/supabaseStorage');
const { createAuthUser, deleteAuthUser } = require('../../models/authUserModel');
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
    console.log(payload);
    // create user record first to ensure user_id exists in auth
    const authUser = await createAuthUser(payload.name, payload.email, payload.password);

    //it automatically sets some columns in users table
    //lets update other fields
    const user_final = await updateUser(authUser.id, payload);

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
    await deleteUser(id);
    await deleteAuthUser(id);
    res.status(204).send();
}

module.exports = { list, getOne, create, update, remove };
