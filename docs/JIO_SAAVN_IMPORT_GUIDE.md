# Jio Saavn Import Feature - Complete Implementation Guide

## Overview

This document describes the complete Jio Saavn import feature for Musee, allowing admins to import tracks, albums, and artists from Jio Saavn with proper error handling, rollback mechanisms, and comprehensive logging.

## Architecture

### Flow Diagram

```
Frontend (Flutter Admin)
    ↓ Search Query
Backend Search APIs
    ↓ Jio Saavn API Response
Display Results to Admin
    ↓ Admin selects album to import
Encrypt Track URLs (✓ Confidential)
    ↓ POST /api/admin/import/album-complete with encrypted URLs
Backend Transaction Handler
    ├─ Step 1: Fetch album metadata from Jio Saavn
    ├─ Step 2: Create Artist (without auth_user if importing)
    ├─ Step 3: Create Album record
    ├─ Step 4: Create Tracks with encrypted download URLs
    ├─ Step 5: Link Artists to Tracks
    └─ Step 6: Publish album (if requested)
    ↓ On any failure → Automatic Rollback
Audit Log Entry (success or failure)
    ↓
Return status to Frontend
```

### Key Features

1. **No Auth Required for Import Users**: Import users are created without needing Supabase auth (user_id = NULL)
2. **Encrypted Download URLs**: Track URLs are encrypted client-side, decrypted server-side only
3. **Transaction with Rollback**: All operations wrapped in a transaction that rolls back on any failure
4. **Comprehensive Logging**: Audit logs track every step of the import process
5. **Dry Run Mode**: Test imports without committing changes
6. **Batch Processing**: Handle multiple tracks in a single import operation

## API Endpoints

### Search Endpoints

#### Search Tracks
```
GET /api/admin/import/search/tracks?query=<search>&limit=<10>
Response: { query, count, tracks: [...] }
```

#### Search Albums
```
GET /api/admin/import/search/albums?query=<search>&limit=<10>
Response: { query, count, albums: [...] }
```

#### Search Artists
```
GET /api/admin/import/search/artists?query=<search>&limit=<10>
Response: { query, count, artists: [...] }
```

### Detail Endpoints

#### Get Track Details
```
GET /api/admin/import/track/:trackId
Response: { id, title, artists, album, duration, language, ... }
```

####Get Album Details (with all tracks)
```
GET /api/admin/import/album/:albumId
Response: { id, title, artists, image, tracks: [...], ... }
```

#### Get Artist Details
```
GET /api/admin/import/artist/:artistId
Response: { id, name, image, bio, followerCount, topSongs: [...] }
```

### Import Endpoints

#### Import Complete Album
```
POST /api/admin/import/album-complete

Request Body:
{
  "jioSaavnAlbumId": "string",        // Required
  "artistName": "string",             // Required
  "artistBio": "string",              // Optional, default: "Imported from Jio Saavn"
  "regionId": "UUID",                 // Optional
  "isPublished": boolean,             // Optional, default: false
  "dryRun": boolean                   // Optional, default: false
}

Success Response (200):
{
  "success": true,
  "sessionId": "UUID",
  "artist": { ... },
  "album": { ... },
  "tracksImported": number,
  "message": "Album imported successfully"
}

Error Response (500):
{
  "success": false,
  "error": "error message",
  "sessionId": "UUID",
  "transaction": {
    "createdCount": number,
    "updatedCount": number,
    "created": [...],
    "updated": [...]
  }
}
```

#### Decrypt and Process Track (Server-side)
```
POST /api/admin/import/decrypt-and-process

Request Body:
{
  "trackId": "UUID",
  "encryptedUrl": "string"
}

Response (200):
{
  "success": true,
  "trackId": "UUID",
  "message": "URL decrypted. Track ready for audio processing"
}
```

## Implementation Details

### 1. User Creation Without Auth

Import users are created with `user_id = NULL`:

```dart
// Flutter
userModel.createImportUser({
  name: artistName,
  email: `import_artist_${uuid}@musee.local`,
  user_type: 'artist',
  subscription_type: 'free',
  settings: { import_source: 'jio_saavn' }
})
```

### 2. Transaction and Rollback

All operations are wrapped in a transaction:

```javascript
// Backend
executeTransaction(
  async (tracker) => {
    // Step 1
    const artist = await createAndTrack(tracker, 'artists', {...});
    // Step 2
    const album = await createAndTrack(tracker, 'albums', {...});
    // Step 3 - if any step fails, all created records are deleted
    // tracktracks.forEach(track => createAndTrack(tracker, ...))
  },
  { dryRun: false, operationName: ... }
)
```

If any step fails:
- All created records are deleted (LIFO order)
- Updated records are restored to original state
- Audit log shows failure status with error details
- Transaction is rolled back automatically

### 3. URL Encryption

**Client-side Encryption:**
```dart
// Flutter
final encryptedUrl = encryptionUtil.encryptData(jioTrackUrl);
// Send encryptedUrl to backend in import request
```

**Server-side Decryption:**
```javascript
// Backend - only on demand
const decryptedUrl = encryptionUtil.decryptData(encryptedUrl);
// Use decryptedUrl to download and process audio
```

### 4. Audit Logging

Every import operation is logged:

```javascript
{
  admin_id: "UUID",
  action: "IMPORT_START" | "IMPORT_COMPLETE" | "IMPORT_ROLLBACK",
  entity_type: "album",
  entity_id: jioSaavnAlbumId,
  status: "pending" | "success" | "failed",
  metadata: {
    session_id: sessionId,
    dry_run: false,
    artist_name: "..."
  }
}
```

Query audit logs:
```
GET /api/admin/audit-logs?action=IMPORT_COMPLETE&status=success
```

### 5. Dry Run Mode

Test imports without committing:

```dart
// Flutter
POST /api/admin/import/album-complete
{
  "dryRun": true,
  ...
}

// Response
{
  "success": true,
  "dryRun": true,
  "transaction": {
    "createdCount": 5,
    "updatedCount": 0
  },
  "message": "DRY RUN - changes would be applied"
}
```

## Database Schema

### audit_logs Table

```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  admin_id UUID NOT NULL REFERENCES auth.users,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  changes JSONB,
  status TEXT,
  result JSONB,
  timestamp TIMESTAMP,
  completed_at TIMESTAMP,
  ip_address TEXT,
  metadata JSONB
);
```

### Modified users Table

```sql
ALTER TABLE users
  ALTER COLUMN user_id DROP NOT NULL;  -- Allow NULL for import users

-- Added indexes
CREATE INDEX idx_users_import_users ON users(user_id) WHERE user_id IS NULL;
```

### settings JSONB Column

Added to artists, albums, tracks:
```json
{
  "jio_saavn_id": "...",          // Store Jio Saavn ID for cross-reference
  "encrypted_download_url": "...", // For tracks (if needed for later re-download)
  "import_source": "jio_saavn",
  "import_date": "2024-03-23",
  "import_session_id": "UUID"
}
```

## Error Handling & Logging

### Log Levels

- **DEBUG**: Individual operation tracking (create, link, update)
- **INFO**: High-level flow steps (fetch album, import tracks, publish)
- **WARN**: Recoverable issues (duplicate artist found, skipped)
- **ERROR**: Failed operations (will trigger rollback)

### Example Log Flow

```
[ImportController] Starting album import: album123 - Session: sess456
[ImportService] Fetching album from Jio Saavn: album123
[ImportService] Fetched album: "My Album" with 10 tracks
[ImportService] Creating artist: John Doe
[ImportService] Created import user: user789
[Transaction] Tracked created: users.user_id=user789
[ImportService] Created new artist: artist456
[Transaction] Tracked created: artists.id=artist456
[ImportService] Creating album: My Album
[ImportService] Created album: album456
[ImportService] Processing 10 tracks
[ImportService] Import track [1/10]: Song 1
[ImportService] Created track: track111
[Transaction] Tracked created: tracks.id=track111
...
[ImportService] Album import completed: 10 tracks imported
[AuditLog] Updated status: log123 → success
[ImportController] Album import successful: Session sess456
```

## Failure Scenario Example

```
[ImportService] Processing 10 tracks
[ImportService] Import track [1/10]: Song 1
[ImportService] Created track: track111
...
[ImportService] Import track [5/10]: Song 5
ERROR: Failed to create artist link for Song 5

[Transaction] Rolling back 5 creations and 0 updates
[Transaction] Deleted rollback: tracks.id=track555
[Transaction] Deleted rollback: tracks.id=track444
[Transaction] Deleted rollback: tracks.id=track333
[Transaction] Deleted rollback: tracks.id=track222
[Transaction] Deleted rollback: tracks.id=track111
[Transaction] Deleted rollback: albums.id=album456
[Transaction] Deleted rollback: artists.id=artist456
[Transaction] Deleted rollback: users.user_id=user789

[AuditLog] Updated status: log123 → failed
[ImportController] Album import failed: Session sess456

Response:
{
  "success": false,
  "error": "Failed to create artist link",
  "sessionId": "sess456",
  "transaction": {
    "createdCount": 8,
    "updatedCount": 0,
    "created": [
      { "table": "users", "id": "user789" },
      { "table": "artists", "id": "artist456" },
      ...
    ]
  }
}
```

## Running Migrations

1. Go to Supabase SQL Editor
2. Copy contents of `docs/migrations/001_import_feature.sql`
3. Run the SQL script
4. Verify audit_logs table created and users.user_id is nullable

## Testing

### Unit Tests

- Test encryption/decryption utility
- Test Jio Saavn client for each search/fetch function
- Test transaction tracker (create, update, delete, rollback)

### Integration Tests

- Import album with 1 track (success)
- Import album with 5 tracks (success)
- Dry run import (verify rollback)
- Import with missing artist (should create)
- Import with existing artist (should reuse)
- Mid-import failure (verify rollback cleans up all records)

### Manual Testing

1. Search for album on Jio Saavn via admin UI
2. Click "Review and Import"
3. Verify album details match Jio Saavn
4. Click "Import with Dry Run" first (should show what would be imported)
5. Click "Import" (should create album, artists, and tracks)
6. Verify audit log shows success
7. Verify artist created without auth_user (user_id = NULL)
8. Verify tracks have encrypted URLs in settings

## Security Considerations

1. **URL Encryption**: Download URLs are encrypted before leaving client, decrypted only on backend
2. **Admin Only**: All import endpoints require admin authentication
3. **Audit Trail**: All imports logged with admin ID and IP address
4. **Import User Isolation**: Import users (user_id = NULL) can't authenticate and have limited permissions
5. **Rate Limiting**: Import endpoint should have rate limiting to prevent abuse

## Dependencies

### Server
- `axios` - HTTP client for Jio Saavn API calls
- `crypto` - Built-in Node.js for encryption

### Client (Flutter)
- `encrypt/encrypt` - Flutter encryption library
- `dio` - Enhanced HTTP client with auth headers

## Known Limitations

1. **Audio Download**: URL decryption endpoint is ready, but actual audio download and processing would need to be implemented in a separate worker service
2. **Video Handling**: Jio Saavn tracks may have video links, not always available
3. **Lyrics**: Lyrics URL from Jio Saavn may not be directly accessible on some networks
4. **Duplicate Detection**: Current implementation doesn't check for existing tracks before importing

## Future Enhancements

1. Add deduplication logic (check if track already exists)
2. Implement audio download worker service
3. Add batch import status UI (progress bar, ETA)
4. Support for updating existing albums via re-import
5. Implement genre mapping from Jio Saavn to local genre table
6. Add user-uploadedPlaylist import support
