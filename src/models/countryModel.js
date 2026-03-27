const { supabase, supabaseAdmin } = require('../db/config');

const table = 'countries';

function client() {
    return supabaseAdmin || supabase;
}

function isUUID(v) {
    return typeof v === 'string' && /^[0-9a-fA-F-]{36}$/.test(v);
}

function sanitizeInsert(payload = {}) {
    const out = {};
    const code = typeof payload.code === 'string' ? payload.code.trim() : '';
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!code) throw new Error('code is required');
    if (code.length != 2) throw new Error('code must be 2 characters long');
    if (!name) throw new Error('name is required');
    out.code = code;
    out.name = name;
    out.created_at = new Date().toISOString();
    return out;
}

function sanitizeUpdate(payload = {}) {
    const out = {};
    if (payload.code !== undefined) {
        const code = typeof payload.code === 'string' ? payload.code.trim() : '';
        if (!code) throw new Error('code cannot be empty');
        if (code.length != 2) throw new Error('code must be 2 characters long');
        out.code = code;
    }
    if (payload.name !== undefined) {
        const name = typeof payload.name === 'string' ? payload.name.trim() : '';
        if (!name) throw new Error('name cannot be empty');
        out.name = name;
    }
    return out;
}

async function listCountries({ limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;
    let qb = client().from(table).select('*', { count: 'exact' }).order('code', { ascending: true });
    if (q) qb = qb.or(`code.ilike.%${q}%,name.ilike.%${q}%`);
    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    return { items: data, total: count };
}

async function getCountry(country_id) {
    const { data, error } = await client().from(table).select('*').eq('country_id', country_id).maybeSingle();
    if (error) throw error;
    return data;
}

async function createCountry(payload) {
    const input = sanitizeInsert(payload);
    const { data, error } = await client().from(table).insert(input).select('*').single();
    if (error) throw error;
    return data;
}

async function updateCountry(country_id, payload) {
    const input = sanitizeUpdate(payload);
    const { data, error } = await client().from(table).update(input).eq('country_id', country_id).select('*').single();
    if (error) throw error;
    return data;
}

async function deleteCountry(country_id) {
    const { error } = await client().from(table).delete().eq('country_id', country_id);
    if (error) throw error;
}

// user functions
async function listCountriesUser({ limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;
    let qb = client().from(table).select('country_id, code, name', { count: 'exact' }).order('code', { ascending: true });
    if (q) qb = qb.or(`code.ilike.%${q}%,name.ilike.%${q}%`);
    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    return { items: data, total: count };
}

async function getCountryUser(country_id) {
    const { data, error } = await client().from(table).select('country_id, code, name').eq('country_id', country_id).maybeSingle();
    if (error) throw error;
    return data;
}

module.exports = { listCountries, getCountry, createCountry, updateCountry, deleteCountry, listCountriesUser, getCountryUser };
