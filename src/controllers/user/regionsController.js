const createError = require('http-errors');
const { listRegionsUser, getRegionUser } = require('../../models/regionModel');
const { isUUID } = require('../../utils/validators');

async function list(req, res) {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const country_id = req.query.country_id || undefined;
    const offset = page * limit;
    const { items, total } = await listRegionsUser({ limit, offset, q, country_id });
    res.json({ items, total, page, limit });
}

async function getOne(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid region id');
    const item = await getRegionUser(id);
    if (!item) throw createError(404, 'Region not found');
    res.json(item);
}

module.exports = { list, getOne};
