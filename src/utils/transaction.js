/**
 * Transaction wrapper for multi-step operations
 * Provides rollback capability on failure
 * Uses Supabase RLS and row-level transaction semantics
 */

const { supabaseAdmin } = require('../db/config');
const logger = require('./logger');

/**
 * Tracks all created/modified records for rollback
 */
class TransactionTracker {
  constructor() {
    this.created = []; // { table, id, primaryKey }
    this.updated = []; // { table, id, primaryKey, backup }
    this.deleted = []; // not used for rollback in this context
  }

  /**
   * Register a newly created record
   * @param {string} table - Table name
   * @param {string} primaryKey - Primary key column name
   * @param {any} id - Primary key value
   */
  trackCreated(table, primaryKey, id) {
    this.created.push({ table, id, primaryKey });
    logger.debug(`[Transaction] Tracked created: ${table}.${primaryKey}=${id}`);
  }

  /**
   * Register an updated record with backup
   * @param {string} table - Table name
   * @param {string} primaryKey - Primary key column name
   * @param {any} id - Primary key value
   * @param {Object} backup - Original data for restoration
   */
  trackUpdated(table, primaryKey, id, backup) {
    this.updated.push({ table, id, primaryKey, backup });
    logger.debug(`[Transaction] Tracked updated: ${table}.${primaryKey}=${id}`);
  }

  /**
   * Performs rollback for all tracked operations
   * Deletes created records and restores updated ones
   * @returns {Promise<void>}
   */
  async rollback() {
    logger.warn(`[Transaction] Rolling back ${this.created.length} creations and ${this.updated.length} updates`);

    try {
      // Delete created records in reverse order (LIFO)
      for (let i = this.created.length - 1; i >= 0; i--) {
        const { table, id, primaryKey } = this.created[i];
        try {
          const result = await supabaseAdmin
            .from(table)
            .delete()
            .eq(primaryKey, id);

          if (result.error) {
            logger.error(`[Transaction] Failed to delete ${table}.${id}:`, result.error);
          } else {
            logger.debug(`[Transaction] Deleted rollback: ${table}.${id}`);
          }
        } catch (error) {
          logger.error(`[Transaction] Exception deleting ${table}.${id}:`, error);
        }
      }

      // Restore updated records
      for (const { table, id, primaryKey, backup } of this.updated) {
        try {
          const result = await supabaseAdmin
            .from(table)
            .update(backup)
            .eq(primaryKey, id);

          if (result.error) {
            logger.error(`[Transaction] Failed to restore ${table}.${id}:`, result.error);
          } else {
            logger.debug(`[Transaction] Restored: ${table}.${id}`);
          }
        } catch (error) {
          logger.error(`[Transaction] Exception restoring ${table}.${id}:`, error);
        }
      }
    } catch (error) {
      logger.error('[Transaction] Rollback failed with exception:', error);
      throw new Error(`Rollback failed: ${error.message}`);
    }
  }

  /**
   * Returns summary of tracked operations
   */
  getSummary() {
    return {
      createdCount: this.created.length,
      updatedCount: this.updated.length,
      created: this.created,
      updated: this.updated
    };
  }
}

/**
 * Wrapper for executing multi-step operations with automatic rollback on failure
 * @param {Function} operation - Async function that performs the operation
 * @param {Object} options - Options
 * @param {boolean} options.dryRun - If true, rollback at end (for testing)
 * @param {string} options.operationName - Name for logging
 * @returns {Promise<{ success: boolean, data, error, transaction }>}
 */
async function executeTransaction(operation, options = {}) {
  const { dryRun = false, operationName = 'unnamed' } = options;
  const tracker = new TransactionTracker();

  logger.info(`[Transaction] Starting: ${operationName}${dryRun ? ' (DRY RUN)' : ''}`);

  try {
    // Execute the operation, passing tracker for record tracking
    const result = await operation(tracker);

    logger.info(`[Transaction] Operation completed: ${operationName}`);

    if (dryRun) {
      logger.info('[Transaction] DRY RUN mode - rolling back all changes');
      await tracker.rollback();
      return {
        success: true,
        data: result,
        dryRun: true,
        transaction: tracker.getSummary(),
        message: 'DRY RUN - changes would be applied'
      };
    }

    return {
      success: true,
      data: result,
      transaction: tracker.getSummary()
    };
  } catch (error) {
    logger.error(`[Transaction] Operation failed: ${operationName}`, error);

    // Automatically rollback on error
    await tracker.rollback();

    return {
      success: false,
      error: error.message,
      transaction: tracker.getSummary(),
      details: error.stack
    };
  }
}

/**
 * Create a record and track it for rollback
 * @param {TransactionTracker} tracker - Transaction tracker
 * @param {string} table - Table name
 * @param {Object} data - Record data
 * @param {string} primaryKey - Primary key column (default: id)
 * @returns {Promise<Object>} Created record with ID
 */
async function createAndTrack(tracker, table, data, primaryKey = 'id') {
  const result = await supabaseAdmin
    .from(table)
    .insert([data])
    .select();

  if (result.error) {
    throw new Error(`Failed to create ${table}: ${result.error.message}`);
  }

  const created = result.data[0];
  tracker.trackCreated(table, primaryKey, created[primaryKey]);

  logger.debug(`[Transaction] Created ${table}: ${created[primaryKey]}`);
  return created;
}

/**
 * Update a record and track original for rollback
 * @param {TransactionTracker} tracker - Transaction tracker
 * @param {string} table - Table name
 * @param {Object} updates - Update data
 * @param {string} primaryKey - Primary key column
 * @param {any} primaryValue - Primary key value
 * @returns {Promise<Object>} Updated record
 */
async function updateAndTrack(tracker, table, updates, primaryKey, primaryValue) {
  // Get current data for backup before update
  const getResult = await supabaseAdmin
    .from(table)
    .select('*')
    .eq(primaryKey, primaryValue)
    .single();

  if (getResult.error) {
    throw new Error(`Failed to fetch ${table} before update: ${getResult.error.message}`);
  }

  tracker.trackUpdated(table, primaryKey, primaryValue, getResult.data);

  // Perform update
  const updateResult = await supabaseAdmin
    .from(table)
    .update(updates)
    .eq(primaryKey, primaryValue)
    .select();

  if (updateResult.error) {
    throw new Error(`Failed to update ${table}: ${updateResult.error.message}`);
  }

  logger.debug(`[Transaction] Updated ${table}: ${primaryValue}`);
  return updateResult.data[0];
}

/**
 * Delete a record (with optional backup for rollback)
 * @param {TransactionTracker} tracker - Transaction tracker
 * @param {string} table - Table name
 * @param {string} primaryKey - Primary key column
 * @param {any} primaryValue - Primary key value
 * @param {boolean} trackForRollback - If true, backup is stored for rollback
 * @returns {Promise<void>}
 */
async function deleteAndTrack(tracker, table, primaryKey, primaryValue, trackForRollback = true) {
  if (trackForRollback) {
    // Get current data for backup before deletion
    const getResult = await supabaseAdmin
      .from(table)
      .select('*')
      .eq(primaryKey, primaryValue)
      .single();

    if (getResult.error && getResult.error.code !== 'PGRST116') {
      // PGRST116 = no rows found
      throw new Error(`Failed to fetch ${table} before delete: ${getResult.error.message}`);
    }

    // Store as update (restore operation)
    if (getResult.data) {
      tracker.trackUpdated(table, primaryKey, primaryValue, getResult.data);
    }
  }

  // Perform delete
  const deleteResult = await supabaseAdmin
    .from(table)
    .delete()
    .eq(primaryKey, primaryValue);

  if (deleteResult.error) {
    throw new Error(`Failed to delete ${table}: ${deleteResult.error.message}`);
  }

  logger.debug(`[Transaction] Deleted ${table}: ${primaryValue}`);
}

module.exports = {
  TransactionTracker,
  executeTransaction,
  createAndTrack,
  updateAndTrack,
  deleteAndTrack
};
