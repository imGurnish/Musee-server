const createError = require('http-errors');
const { listCountriesUser, getCountryUser } = require('../../models/countryModel');
const { isUUID } = require('../../utils/validators');

async function list(req, res) {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listCountriesUser({ limit, offset, q });
    res.json({ items, total, page, limit });
}

async function getOne(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid country id');
    const item = await getCountryUser(id);
    if (!item) throw createError(404, 'Country not found');
    res.json(item);
}

module.exports = { list, getOne };
