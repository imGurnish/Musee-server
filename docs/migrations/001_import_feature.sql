/**
 * Database Migrations for Import Feature
 * Run these migrations in Supabase SQL Editor
 */

-- ============================================
-- MIGRATION 1: Create audit_logs table
-- ============================================
-- This table tracks all admin actions for compliance and debugging

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Who performed the action
  admin_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  
  -- What action was performed
  action TEXT NOT NULL CHECK (
    action IN (
      'CREATE', 'UPDATE', 'DELETE',
      'IMPORT_START', 'IMPORT_STEP', 'IMPORT_COMPLETE', 'IMPORT_ROLLBACK',
      'LOGIN', 'LOGOUT', 'PERMISSION_CHANGE'
    )
  ),
  
  -- What type of entity was affected
  entity_type TEXT NOT NULL,
  
  -- ID of the affected entity
  entity_id TEXT,
  
  -- Description of changes (before/after values)
  changes JSONB,
  
  -- Status of the operation
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  
  -- Result data if operation completed
  result JSONB,
  
  -- When the operation started
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  -- When the operation completed
  completed_at TIMESTAMP WITH TIME ZONE,
  
  -- IP address of the requester
  ip_address TEXT,
  
  -- Additional metadata
  metadata JSONB,
  
  -- Indexes for common queries
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for audit log queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id ON audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_status ON audit_logs(status);

-- Enable row-level security
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Allow admins to read audit logs
CREATE POLICY "Admins can read audit logs" ON audit_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
      AND auth.users.raw_user_meta_data->>'role' = 'admin'
    )
  );

-- Allow system to insert audit logs
CREATE POLICY "System can insert audit logs" ON audit_logs
  FOR INSERT WITH CHECK (true);

-- ============================================
-- MIGRATION 2: Modify users table to make user_id nullable
-- ============================================
-- This enables import users who don't have Supabase auth

-- Drop foreign key constraint if it exists
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_user_id_fkey;

-- Make user_id nullable
ALTER TABLE users
  ALTER COLUMN user_id DROP NOT NULL;

-- Recreate foreign key with ON DELETE SET NULL
ALTER TABLE users
  ADD CONSTRAINT users_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Create index for import users (where user_id IS NULL)
CREATE INDEX IF NOT EXISTS idx_users_import_users ON users(user_id) WHERE user_id IS NULL;

-- ============================================
-- MIGRATION 3: Add import metadata to artists table
-- ============================================
-- Store Jio Saavn IDs for cross-reference

ALTER TABLE artists
  ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';

-- Create index for quick lookup by import source
CREATE INDEX IF NOT EXISTS idx_artists_jio_saavn_id ON artists
  USING GIN (settings) WHERE settings->>'jio_saavn_id' IS NOT NULL;

-- ============================================
-- MIGRATION 4: Add import metadata to albums table
-- ============================================

ALTER TABLE albums
  ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_albums_jio_saavn_id ON albums
  USING GIN (settings) WHERE settings->>'jio_saavn_id' IS NOT NULL;

-- ============================================
-- MIGRATION 5: Add import metadata to tracks table
-- ============================================

ALTER TABLE tracks
  ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_tracks_jio_saavn_id ON tracks
  USING GIN (settings) WHERE settings->>'jio_saavn_id' IS NOT NULL;

-- ============================================
-- Done!
-- ============================================
