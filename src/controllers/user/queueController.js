const createError = require('http-errors');
const { getRedisClient } = require('../../utils/redisClient');
const { listTracksUser, listTracksByIdsUser } = require('../../models/trackModel');
const { isUUID } = require('../../utils/validators');

function queueKey(userId) { return `user:queue:${userId}`; }
function metaKey(trackId) { return `track:meta:${trackId}`; }

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
  // const ids = await ensureMinQueue(userId, 10);
  // DISABLED: Rely on frontend smart fill
  const ids = await client.lRange(queueKey(userId), 0, -1);
  const expand = req.query.expand === '1' || req.query.expand === 'true';
  if (!expand) return res.json({ items: ids, total: ids.length });

  const separated = ids.reduce((acc, id) => {
    if (isUUID(id)) acc.db.push(id);
    else acc.ext.push(id);
    return acc;
  }, { db: [], ext: [] });

  // Fetch DB tracks
  let dbTracks = [];
  if (separated.db.length > 0) {
    dbTracks = await listTracksByIdsUser(separated.db);
  }
  const dbMap = new Map(dbTracks.map(t => [t.track_id, t]));

  // Fetch External Metadata
  const extMap = new Map();
  if (separated.ext.length > 0) {
    const keys = separated.ext.map(id => metaKey(id));
    const metas = await client.mGet(keys);
    separated.ext.forEach((id, idx) => {
      const json = metas[idx];
      if (json) {
        try {
          extMap.set(id, JSON.parse(json));
        } catch (e) { }
      }
    });
  }

  // Merge back in order
  const items = ids.map(id => {
    if (dbMap.has(id)) return dbMap.get(id);
    if (extMap.has(id)) return { ...extMap.get(id), track_id: id };
    // Fallback
    return {
      track_id: id,
      title: 'External Track',
      artists: [],
      album: {},
      duration: 0
    };
  });

  return res.json({ items, total: ids.length });
}

// POST /api/user/queue/add  { track_id, metadata? } | { track_ids: [], metadata: []? }
async function addToQueue(req, res) {
  const userId = req.user?.id;
  if (!userId) throw createError(401, 'Unauthorized');
  const client = await getRedisClient();

  let ids = [];
  let metas = [];

  if (req.body?.track_id) {
    ids = [String(req.body.track_id)];
    if (req.body.metadata) metas = [req.body.metadata];
  }
  if (Array.isArray(req.body?.track_ids)) {
    ids = req.body.track_ids.map(String);
    if (Array.isArray(req.body?.metadata_list)) metas = req.body.metadata_list;
  }

  if (!ids.length) throw createError(400, 'track_id or track_ids required');

  // Store metadata for external tracks
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!isUUID(id) && i < metas.length && metas[i]) {
      await client.set(metaKey(id), JSON.stringify(metas[i]), { EX: 86400 * 7 }); // 7 days expiry
    } else if (!isUUID(id) && req.body.metadata && ids.length === 1) {
      // Single add with metadata
      await client.set(metaKey(id), JSON.stringify(req.body.metadata), { EX: 86400 * 7 });
    }
  }

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

// POST /api/user/queue/play { track_id, metadata? }
// Resets the queue to [track_id, ...10 next tracks]
async function playTrack(req, res) {
  const userId = req.user?.id;
  if (!userId) throw createError(401, 'Unauthorized');
  const { track_id, metadata } = req.body || {};
  if (!track_id) throw createError(400, 'track_id is required');
  const startId = String(track_id);

  const client = await getRedisClient();

  // Store metadata if external
  if (!isUUID(startId) && metadata) {
    await client.set(metaKey(startId), JSON.stringify(metadata), { EX: 86400 * 7 });
  }

  // Only init queue with the requested track.
  // Allow Client to populate the rest via Smart Recommendations.
  const fullQueue = [startId];

  const key = queueKey(userId);
  await client.del(key);
  await client.rPush(key, fullQueue);

  // Ensure minimum size in case we couldn't gather 10 unique
  // const ensured = await ensureMinQueue(userId, 10);
  // DISABLED: Rely on frontend smart fill
  const ensured = await client.lRange(key, 0, -1);

  const expand = req.query.expand === '1' || req.query.expand === 'true';
  if (!expand) return res.status(201).json({ items: ensured, total: ensured.length });

  // Expand
  const separated = ensured.reduce((acc, id) => {
    if (isUUID(id)) acc.db.push(id);
    else acc.ext.push(id);
    return acc;
  }, { db: [], ext: [] });

  let dbTracks = [];
  if (separated.db.length > 0) {
    dbTracks = await listTracksByIdsUser(separated.db);
  }
  const dbMap = new Map(dbTracks.map(t => [t.track_id, t]));

  const extMap = new Map();
  if (separated.ext.length > 0) {
    const keys = separated.ext.map(id => metaKey(id));
    const metas = await client.mGet(keys);
    separated.ext.forEach((id, idx) => {
      const json = metas[idx];
      if (json) {
        try {
          extMap.set(id, JSON.parse(json));
        } catch (e) { }
      }
    });
  }

  const expanded = ensured.map(id => {
    if (dbMap.has(id)) return dbMap.get(id);
    if (extMap.has(id)) return { ...extMap.get(id), track_id: id };
    return {
      track_id: id,
      title: 'External Track',
      artists: [],
      album: {},
      duration: 0
    };
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
