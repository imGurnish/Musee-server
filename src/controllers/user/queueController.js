const createError = require('http-errors');
const { getRedisClient } = require('../../utils/redisClient');
const { listTracksUser, listTracksByIdsUser } = require('../../models/trackModel');
const { isUUID } = require('../../utils/validators');

function queueKey(userId) { return `user:queue:${userId}`; }

async function ensureMinQueue(userId, minSize = 10) {
  const client = await getRedisClient();
  const key = queueKey(userId);
  let ids = await client.lRange(key, 0, -1);
  if (ids.length >= minSize) return ids;

  // determine how many to add
  const need = minSize - ids.length;
  // get total published tracks count
  const { total } = await listTracksUser({ limit: 1, offset: 0 });
  if (!total || total <= 0) return ids;

  const seen = new Set(ids);
  const candidates = [];
  // fetch in a few random windows until we collect enough unique ids
  const FETCH_LIMIT = Math.min(50, Math.max(need * 2, 20));
  const maxOffset = Math.max(0, total - FETCH_LIMIT);
  let attempts = 0;
  while (candidates.length < need && attempts < 5) {
    const offset = maxOffset > 0 ? Math.floor(Math.random() * (maxOffset + 1)) : 0;
    const { items } = await listTracksUser({ limit: FETCH_LIMIT, offset });
    for (const t of (items || [])) {
      const id = t.track_id;
      if (!seen.has(id)) {
        seen.add(id);
        candidates.push(id);
        if (candidates.length >= need) break;
      }
    }
    attempts++;
    if ((items || []).length === 0) break;
  }
  if (candidates.length) await client.rPush(key, candidates);
  ids = await client.lRange(key, 0, -1);
  return ids;
}

// GET /api/user/queue?expand=0|1
async function getQueue(req, res) {
  const userId = req.user?.id;
  if (!userId) throw createError(401, 'Unauthorized');
  const client = await getRedisClient();
  // Always ensure the queue has at least 10 items while user is listening
  const ids = await ensureMinQueue(userId, 10);
  const expand = req.query.expand === '1' || req.query.expand === 'true';
  if (!expand) return res.json({ items: ids, total: ids.length });

  const found = await listTracksByIdsUser(ids);
  const foundMap = new Map(found.map(i => [i.track_id, i]));

  const items = ids.map(id => foundMap.get(id) || {
    track_id: id,
    title: 'External Track',
    artists: [],
    album: {},
    duration: 0
  });

  return res.json({ items, total: ids.length });
}

// POST /api/user/queue/add  { track_id } | { track_ids: [] }
async function addToQueue(req, res) {
  const userId = req.user?.id;
  if (!userId) throw createError(401, 'Unauthorized');
  const client = await getRedisClient();
  let ids = [];
  if (req.body?.track_id) ids = [String(req.body.track_id)];
  if (Array.isArray(req.body?.track_ids)) ids = req.body.track_ids.map(String);
  if (!ids.length) throw createError(400, 'track_id or track_ids required');
  // Append to the end
  if (ids.length === 1) await client.rPush(queueKey(userId), ids[0]);
  else await client.rPush(queueKey(userId), ids);
  const newLen = await client.lLen(queueKey(userId));
  res.status(201).json({ ok: true, total: newLen });
}

// DELETE /api/user/queue/:track_id  -> remove first occurrence
async function removeFromQueue(req, res) {
  const userId = req.user?.id;
  if (!userId) throw createError(401, 'Unauthorized');
  const { track_id } = req.params;
  const client = await getRedisClient();
  const removed = await client.lRem(queueKey(userId), 1, String(track_id));
  const ids = await ensureMinQueue(userId, 10);
  res.json({ ok: true, removed, total: ids.length });
}

// POST /api/user/queue/reorder { fromIndex, toIndex }
async function reorderQueue(req, res) {
  const userId = req.user?.id;
  if (!userId) throw createError(401, 'Unauthorized');
  const { fromIndex, toIndex } = req.body || {};
  const from = Number(fromIndex);
  const to = Number(toIndex);
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw createError(400, 'fromIndex and toIndex must be integers');
  const client = await getRedisClient();
  const list = await client.lRange(queueKey(userId), 0, -1);
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) throw createError(400, 'index out of bounds');
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  // overwrite
  const key = queueKey(userId);
  await client.del(key);
  if (list.length) await client.rPush(key, list);
  res.json({ ok: true, items: list });
}

// POST /api/user/queue/clear
async function clearQueue(req, res) {
  const userId = req.user?.id;
  if (!userId) throw createError(401, 'Unauthorized');
  const client = await getRedisClient();
  await client.del(queueKey(userId));
  res.json({ ok: true });
}

// POST /api/user/queue/play { track_id }
// Resets the queue to [track_id, ...10 next tracks]
async function playTrack(req, res) {
  const userId = req.user?.id;
  if (!userId) throw createError(401, 'Unauthorized');
  const { track_id } = req.body || {};
  if (!track_id) throw createError(400, 'track_id is required');
  const startId = String(track_id);

  // fetch next 10 published tracks (simple random offset approach)
  const LIMIT = 10;
  // first get total
  const { total } = await listTracksUser({ limit: 1, offset: 0 });
  const maxOffset = Math.max(0, (total || 0) - LIMIT);
  const offset = maxOffset > 0 ? Math.floor(Math.random() * (maxOffset + 1)) : 0;
  const { items } = await listTracksUser({ limit: LIMIT + 5, offset }); // fetch a few extra
  const next = [];
  for (const t of items) {
    if (next.length >= LIMIT) break;
    if (t.track_id !== startId) next.push(t.track_id);
  }

  const fullQueue = [startId, ...next.slice(0, LIMIT)];

  const client = await getRedisClient();
  const key = queueKey(userId);
  await client.del(key);
  await client.rPush(key, fullQueue);

  // Ensure minimum size in case we couldn't gather 10 unique
  const ensured = await ensureMinQueue(userId, 10);
  const expand = req.query.expand === '1' || req.query.expand === 'true';
  if (!expand) return res.status(201).json({ items: ensured, total: ensured.length });

  const found = await listTracksByIdsUser(ensured);
  const foundMap = new Map(found.map(i => [i.track_id, i]));

  const expanded = ensured.map(id => foundMap.get(id) || {
    track_id: id,
    title: 'External Track',
    artists: [],
    album: {},
    duration: 0
  });

  return res.status(201).json({ items: expanded, total: ensured.length });
}

module.exports = {
  getQueue,
  addToQueue,
  removeFromQueue,
  reorderQueue,
  clearQueue,
  playTrack,
};
