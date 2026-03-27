/**
 * Audit Log Model - Track all changes for compliance and debugging
 */

const { supabaseAdmin } = require('../db/config');
const logger = require('../utils/logger');

/**
 * Create an audit log entry
 * @param {Object} data - Audit log data
 * @param {string} data.admin_id - ID of admin performing action
 * @param {string} data.action - Action type (CREATE, UPDATE, DELETE, IMPORT_START, IMPORT_COMPLETE, IMPORT_ROLLBACK)
 * @param {string} data.entity_type - Type of entity (user, artist, album, track, etc.)
 * @param {string} data.entity_id - ID of the affected entity
 * @param {Object} data.changes - Object describing changes (before/after)
 * @param {string} data.status - Status (success, failed, pending)
 * @param {string} data.ip_address - IP address of requester
 * @param {Object} data.metadata - Additional metadata
 * @returns {Promise<Object>} Created audit log
 */
async function createAuditLog(data) {
  try {
    const timestamp = new Date();
    
    const auditData = {
      admin_id: data.admin_id,
      action: data.action,
      entity_type: data.entity_type,
      entity_id: data.entity_id,
      changes: data.changes,
      status: data.status || 'pending',
      ip_address: data.ip_address,
      metadata: data.metadata,
      timestamp: timestamp
    };

    const result = await supabaseAdmin
      .from('audit_logs')
      .insert([auditData])
      .select();

    if (result.error) {
      logger.error('[AuditLog] Failed to create audit log:', result.error);
      // Don't throw - audit failures shouldn't break operations
      return null;
    }

    logger.debug(`[AuditLog] Created: ${data.action} on ${data.entity_type} ${data.entity_id}`);
    return result.data[0];
  } catch (error) {
    logger.error('[AuditLog] Exception creating audit log:', error);
    // Don't throw
    return null;
  }
}

/**
 * Update audit log status
 * @param {string} logId - Audit log ID
 * @param {string} newStatus - New status (success, failed)
 * @param {Object} result - Result data
 * @returns {Promise<Object>} Updated audit log
 */
async function updateAuditLogStatus(logId, newStatus, result = null) {
  try {
    const updateData = {
      status: newStatus,
      completed_at: new Date()
    };

    if (result) {
      updateData.result = result;
    }

    const updateResult = await supabaseAdmin
      .from('audit_logs')
      .update(updateData)
      .eq('id', logId)
      .select();

    if (updateResult.error) {
      logger.error('[AuditLog] Failed to update audit log status:', updateResult.error);
      return null;
    }

    logger.debug(`[AuditLog] Updated status: ${logId} → ${newStatus}`);
    return updateResult.data[0];
  } catch (error) {
    logger.error('[AuditLog] Exception updating audit log:', error);
    return null;
  }
}

/**
 * Get audit logs with filtering
 * @param {Object} filters - Filter options
 * @param {string} filters.admin_id - Filter by admin
 * @param {string} filters.entity_type - Filter by entity type
 * @param {string} filters.action - Filter by action
 * @param {string} filters.status - Filter by status
 * @param {number} filters.limit - Result limit
 * @param {number} filters.offset - Pagination offset
 * @returns {Promise<Array>} Audit logs
 */
async function getAuditLogs(filters = {}) {
  try {
    let query = supabaseAdmin
      .from('audit_logs')
      .select('*');

    if (filters.admin_id) {
      query = query.eq('admin_id', filters.admin_id);
    }

    if (filters.entity_type) {
      query = query.eq('entity_type', filters.entity_type);
    }

    if (filters.action) {
      query = query.eq('action', filters.action);
    }

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    // Pagination
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;
    query = query.range(offset, offset + limit - 1);

    // Sort by newest first
    query = query.order('timestamp', { ascending: false });

    const result = await query;

    if (result.error) {
      logger.error('[AuditLog] Failed to fetch audit logs:', result.error);
      return [];
    }

    return result.data || [];
  } catch (error) {
    logger.error('[AuditLog] Exception fetching audit logs:', error);
    return [];
  }
}

/**
 * Get import session logs
 * @param {string} sessionId - Import session ID
 * @returns {Promise<Array>} Logs for import session
 */
async function getImportSessionLogs(sessionId) {
  try {
    const result = await supabaseAdmin
      .from('audit_logs')
      .select('*')
      .or(`metadata->session_id.eq.${sessionId},action.in.(IMPORT_START,IMPORT_STEP,IMPORT_COMPLETE,IMPORT_ROLLBACK)`)
      .order('timestamp', { ascending: true });

    if (result.error) {
      logger.error('[AuditLog] Failed to fetch import session logs:', result.error);
      return [];
    }

    return result.data || [];
  } catch (error) {
    logger.error('[AuditLog] Exception fetching import session logs:', error);
    return [];
  }
}

module.exports = {
  createAuditLog,
  updateAuditLogStatus,
  getAuditLogs,
  getImportSessionLogs
};
