const createError = require('http-errors');
const {
    listPlans,
    getPlan,
    createPlan,
    updatePlan,
    deletePlan,
} = require('../../models/planModel');
const { isUUID } = require('../../utils/validators');

async function list(req, res) {
    const items = await listPlans();
    res.json({ items });
}

async function getOne(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid plan id');
    const item = await getPlan(id);
    if (!item) throw createError(404, 'Plan not found');
    res.json(item);
}

async function create(req, res) {
    const item = await createPlan(req.body);
    res.status(201).json(item);
}

async function update(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid plan id');
    const existing = await getPlan(id);
    if (!existing) throw createError(404, 'Plan not found');
    const item = await updatePlan(id, req.body);
    res.json(item);
}

async function remove(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid plan id');
    const existing = await getPlan(id);
    if (!existing) throw createError(404, 'Plan not found');
    await deletePlan(id);
    res.status(204).send();
}

module.exports = { list, getOne, create, update, remove };
