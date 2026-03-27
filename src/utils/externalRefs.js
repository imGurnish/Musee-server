const { supabase, supabaseAdmin } = require('../db/config');

function db() {
  return supabaseAdmin || supabase;
}

function normalizeProviderCode(providerCode) {
  const raw = typeof providerCode === 'string' ? providerCode.trim().toLowerCase() : '';
  return raw || 'jiosaavn';
}

async function getProviderId(providerCode = 'jiosaavn') {
  const code = normalizeProviderCode(providerCode);
  const result = await db()
    .from('external_providers')
    .select('provider_id')
    .eq('code', code)
    .maybeSingle();

  if (result.error) throw result.error;
  if (result.data?.provider_id) return result.data.provider_id;

  if (code === 'jiosaavn') {
    return 1;
  }

  throw new Error(`external provider not found: ${code}`);
}

async function findEntityIdByExternalId({
  refTable,
  entityIdColumn,
  providerId,
  externalId,
}) {
  if (!providerId || !externalId) return null;

  const result = await db()
    .from(refTable)
    .select(entityIdColumn)
    .eq('provider_id', providerId)
    .eq('external_id', String(externalId))
    .maybeSingle();

  if (result.error) throw result.error;
  return result.data?.[entityIdColumn] || null;
}

async function upsertExternalRef({
  refTable,
  entityIdColumn,
  entityId,
  providerId,
  externalId,
  externalUrl = null,
  imageUrl = null,
  rawPayload = null,
  extra = {},
}) {
  if (!entityId || !providerId || !externalId) return null;

  const payload = {
    [entityIdColumn]: entityId,
    provider_id: providerId,
    external_id: String(externalId),
    external_url: externalUrl,
    image_url: imageUrl,
    raw_payload: rawPayload,
    ...extra,
  };

  const existingByExternal = await db()
    .from(refTable)
    .select('*')
    .eq('provider_id', providerId)
    .eq('external_id', String(externalId))
    .maybeSingle();

  if (existingByExternal.error) throw existingByExternal.error;

  if (existingByExternal.data) {
    const updateResult = await db()
      .from(refTable)
      .update({
        ...payload,
        [entityIdColumn]: existingByExternal.data[entityIdColumn] || entityId,
      })
      .eq('provider_id', providerId)
      .eq('external_id', String(externalId))
      .select('*')
      .maybeSingle();
    if (updateResult.error) throw updateResult.error;
    return updateResult.data;
  }

  const existingByEntityProvider = await db()
    .from(refTable)
    .select('*')
    .eq(entityIdColumn, entityId)
    .eq('provider_id', providerId)
    .maybeSingle();

  if (existingByEntityProvider.error) throw existingByEntityProvider.error;

  if (existingByEntityProvider.data) {
    const updateResult = await db()
      .from(refTable)
      .update(payload)
      .eq(entityIdColumn, entityId)
      .eq('provider_id', providerId)
      .select('*')
      .maybeSingle();
    if (updateResult.error) throw updateResult.error;
    return updateResult.data;
  }

  const insertResult = await db()
    .from(refTable)
    .insert(payload)
    .select('*')
    .maybeSingle();

  if (insertResult.error) {
    if (String(insertResult.error.code) === '23505') {
      const racedByExternal = await db()
        .from(refTable)
        .select('*')
        .eq('provider_id', providerId)
        .eq('external_id', String(externalId))
        .maybeSingle();

      if (racedByExternal.error) throw racedByExternal.error;
      if (racedByExternal.data) return racedByExternal.data;

      const racedByEntityProvider = await db()
        .from(refTable)
        .select('*')
        .eq(entityIdColumn, entityId)
        .eq('provider_id', providerId)
        .maybeSingle();

      if (racedByEntityProvider.error) throw racedByEntityProvider.error;
      if (racedByEntityProvider.data) return racedByEntityProvider.data;
    }

    throw insertResult.error;
  }
  return insertResult.data;
}

module.exports = {
  getProviderId,
  findEntityIdByExternalId,
  upsertExternalRef,
};
