/**
 * Import Controller - Handles Jio Saavn imports with proper rollback and logging
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../utils/logger');
const {
  executeTransaction,
  createAndTrack,
  updateAndTrack,
  deleteAndTrack,
  TransactionTracker
} = require('../../utils/transaction');
const {
  createAuditLog,
  updateAuditLogStatus
} = require('../../models/auditLogModel');
const jioSaavnClient = require('../../utils/jioSaavnClient');
const encryptionUtil = require('../../utils/encryptionUtil');
const { getProviderId, findEntityIdByExternalId, upsertExternalRef } = require('../../utils/externalRefs');
const userModel = require('../../models/userModel');
const artistModel = require('../../models/artistModel');
const albumModel = require('../../models/albumModel');
const trackModel = require('../../models/trackModel');
const { supabaseAdmin } = require('../../db/config');

const LANGUAGE_NAME_TO_CODE = {
  english: 'en',
  hindi: 'hi',
  punjabi: 'pa',
  bengali: 'bn',
  tamil: 'ta',
  telugu: 'te',
  marathi: 'mr',
  gujarati: 'gu',
  urdu: 'ur',
  malayalam: 'ml',
  kannada: 'kn'
};

function normalizeLanguageCode(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (!value) return null;
  if (/^[a-z]{2,3}(-[a-z]{2})?$/.test(value)) return value;
  return LANGUAGE_NAME_TO_CODE[value] || null;
}

function languageNameFromCodeOrInput(code, input) {
  const codeToName = {
    en: 'English',
    hi: 'Hindi',
    pa: 'Punjabi',
    bn: 'Bengali',
    ta: 'Tamil',
    te: 'Telugu',
    mr: 'Marathi',
    gu: 'Gujarati',
    ur: 'Urdu',
    ml: 'Malayalam',
    kn: 'Kannada'
  };
  if (codeToName[code]) return codeToName[code];
  if (typeof input === 'string' && input.trim()) {
    const v = input.trim();
    return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
  }
  return 'Unknown';
}

function normalizeForNameMatch(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isDefaultAvatarUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return true;
  return url.includes('default_avatar.png');
}

async function resolveBestArtistImageUrl(artistName, fallbackImageUrl = null) {
  const fallback = typeof fallbackImageUrl === 'string' && fallbackImageUrl.trim()
    ? fallbackImageUrl.trim()
    : null;

  try {
    const candidates = await jioSaavnClient.searchArtists(artistName, 10);
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return fallback;
    }

    const normalizedInput = normalizeForNameMatch(artistName);
    const withImage = candidates.filter(
      (candidate) => typeof candidate?.image === 'string' && candidate.image.trim().length > 0
    );

    if (withImage.length === 0) {
      return fallback;
    }

    const exact = withImage.find(
      (candidate) => normalizeForNameMatch(candidate.name) === normalizedInput
    );
    if (exact) {
      return exact.image.trim();
    }

    const partial = withImage.find((candidate) => {
      const normalizedCandidate = normalizeForNameMatch(candidate.name);
      return (
        normalizedCandidate.includes(normalizedInput) ||
        normalizedInput.includes(normalizedCandidate)
      );
    });
    if (partial) {
      return partial.image.trim();
    }

    return withImage[0].image.trim();
  } catch (error) {
    logger.warn(
      `[ImportService] Could not resolve artist image for "${artistName}": ${error.message}`
    );
    return fallback;
  }
}

async function ensureLanguageExists(languageCode, languageName) {
  if (!languageCode) return;
  const existing = await supabaseAdmin
    .from('languages')
    .select('language_code')
    .eq('language_code', languageCode)
    .maybeSingle();

  if (existing.error) throw existing.error;
  if (existing.data) return;

  const inserted = await supabaseAdmin
    .from('languages')
    .insert({ language_code: languageCode, name: languageName || 'Unknown' });

  if (inserted.error) throw inserted.error;
  logger.info(`[ImportService] Created missing language: ${languageCode}`);
}

/**
 * Search Jio Saavn for tracks
 * GET /api/admin/import/search/tracks
 */
async function searchTracks(req, res) {
  try {
    const { query, limit = 10 } = req.query;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'query parameter is required' });
    }

    logger.info(`[ImportController] Searching tracks: ${query}`);

    const tracks = await jioSaavnClient.searchTracks(query, Math.min(50, parseInt(limit) || 10));

    res.status(200).json({
      query,
      count: tracks.length,
      tracks
    });
  } catch (error) {
    logger.error('[ImportController] Search tracks failed:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Get detailed info for a track from Jio Saavn
 * GET /api/admin/import/track/:trackId
 */
async function getTrackDetails(req, res) {
  try {
    const { trackId } = req.params;

    logger.info(`[ImportController] Fetching track: ${trackId}`);

    const track = await jioSaavnClient.getTrack(trackId);

    res.status(200).json(track);
  } catch (error) {
    logger.error('[ImportController] Get track failed:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Search Jio Saavn for albums
 * GET /api/admin/import/search/albums
 */
async function searchAlbums(req, res) {
  try {
    const { query, limit = 10 } = req.query;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'query parameter is required' });
    }

    logger.info(`[ImportController] Searching albums: ${query}`);

    const albums = await jioSaavnClient.searchAlbums(query, Math.min(50, parseInt(limit) || 10));

    res.status(200).json({
      query,
      count: albums.length,
      albums
    });
  } catch (error) {
    logger.error('[ImportController] Search albums failed:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Get detailed info for an album from Jio Saavn (with all tracks)
 * GET /api/admin/import/album/:albumId
 */
async function getAlbumDetails(req, res) {
  try {
    const { albumId } = req.params;

    logger.info(`[ImportController] Fetching album: ${albumId}`);

    const album = await jioSaavnClient.getAlbum(albumId);

    res.status(200).json(album);
  } catch (error) {
    logger.error('[ImportController] Get album failed:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Search Jio Saavn for artists
 * GET /api/admin/import/search/artists
 */
async function searchArtists(req, res) {
  try {
    const { query, limit = 10 } = req.query;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'query parameter is required' });
    }

    logger.info(`[ImportController] Searching artists: ${query}`);

    const artists = await jioSaavnClient.searchArtists(query, Math.min(50, parseInt(limit) || 10));

    res.status(200).json({
      query,
      count: artists.length,
      artists
    });
  } catch (error) {
    logger.error('[ImportController] Search artists failed:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Get detailed info for an artist from Jio Saavn
 * GET /api/admin/import/artist/:artistId
 */
async function getArtistDetails(req, res) {
  try {
    const { artistId } = req.params;

    logger.info(`[ImportController] Fetching artist: ${artistId}`);

    const artist = await jioSaavnClient.getArtist(artistId);

    res.status(200).json(artist);
  } catch (error) {
    logger.error('[ImportController] Get artist failed:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Import a complete album with all tracks and artist from Jio Saavn
 * POST /api/admin/import/album-complete
 *
 * Request Body:
 * {
 *   jimSaavnAlbumId: string,
 *   artistName: string,
 *   artistBio?: string,
 *   regionId?: UUID,
 *   isPublished?: boolean,
 *   dryRun?: boolean
 * }
 */
async function importCompleteAlbum(req, res) {
  const sessionId = uuidv4();
  const adminId = req.user?.id;
  let auditLogId = null;

  try {
    const {
      jioSaavnAlbumId,
      artistName,
      artistBio = 'Imported from Jio Saavn',
      regionId = null,
      isPublished = false,
      dryRun = false
    } = req.body;

    if (!jioSaavnAlbumId || !artistName) {
      return res.status(400).json({
        error: 'jioSaavnAlbumId and artistName are required'
      });
    }

    logger.info(`[ImportController] Starting album import: ${jioSaavnAlbumId} - Session: ${sessionId}`);

    // Create audit log entry
    auditLogId = (await createAuditLog({
      admin_id: adminId,
      action: 'IMPORT_START',
      entity_type: 'album',
      entity_id: jioSaavnAlbumId,
      status: 'pending',
      ip_address: req.ip,
      metadata: {
        session_id: sessionId,
        dry_run: dryRun,
        artist_name: artistName
      }
    }))?.id;

    // Execute import transaction
    const result = await executeTransaction(
      async (tracker) => {
        logger.info(`[ImportService] Fetching album from Jio Saavn: ${jioSaavnAlbumId}`);
        const providerId = await getProviderId('jiosaavn');

        // Step 1: Fetch album details from Jio Saavn
        const jioAlbum = await jioSaavnClient.getAlbum(jioSaavnAlbumId);
        const artistImageUrl = await resolveBestArtistImageUrl(artistName, jioAlbum.image);

        logger.info(`[ImportService] Fetched album: ${jioAlbum.title} with ${jioAlbum.tracks.length} tracks`);

        // Step 2: Create or find artist
        logger.info(`[ImportService] Creating artist: ${artistName}`);

        let artist;
        const existingArtist = await supabaseAdmin
          .from('artists')
          .select('*')
          .ilike('name', artistName)
          .maybeSingle();

        if (existingArtist.data) {
          logger.debug(`[ImportService] Artist already exists: ${existingArtist.data.id}`);
          artist = existingArtist.data;

          const artistId = artist.artist_id || artist.id;
          if (artistImageUrl && artistId) {
            if (!artist.cover_url) {
              artist = await updateAndTrack(
                tracker,
                'artists',
                { cover_url: artistImageUrl },
                'artist_id',
                artistId
              );
            }

            const existingUser = await supabaseAdmin
              .from('users')
              .select('avatar_url')
              .eq('user_id', artistId)
              .maybeSingle();

            if (existingUser.error) {
              throw existingUser.error;
            }

            const existingAvatar = existingUser.data?.avatar_url || null;
            if (isDefaultAvatarUrl(existingAvatar)) {
              await updateAndTrack(
                tracker,
                'users',
                { avatar_url: artistImageUrl },
                'user_id',
                artistId
              );
            }
          }
        } else {
          // Create import user (without auth_user)
          const importUser = await createAndTrack(tracker, 'users', {
            name: artistName,
            email: `import_artist_${uuidv4()}@musee.local`,
            user_type: 'artist',
            subscription_type: 'free',
            avatar_url: artistImageUrl,
            settings: { import_source: 'jio_saavn' }
          }, 'user_id');

          logger.debug(`[ImportService] Created import user: ${importUser.user_id}`);

          // Create artist record
          artist = await createAndTrack(
            tracker,
            'artists',
            {
              user_id: importUser.user_id,
              name: artistName,
              bio: artistBio,
              cover_url: artistImageUrl || 'https://via.placeholder.com/300x300?text=Artist',
              region_id: regionId,
              is_verified: false,
              monthly_listeners: 0,
              debut_year: jioAlbum.year,
              settings: { jio_saavn_id: jioAlbum.id }
            },
            'id'
          );

          logger.info(`[ImportService] Created new artist: ${artist.artist_id || artist.id}`);
        }

        // Step 3: Create album record
        logger.info(`[ImportService] Creating album: ${jioAlbum.title}`);
        const existingAlbumId = await findEntityIdByExternalId({
          refTable: 'album_external_refs',
          entityIdColumn: 'album_id',
          providerId,
          externalId: jioSaavnAlbumId,
        });

        let album;
        if (existingAlbumId) {
          const existingAlbum = await supabaseAdmin.from('albums').select('*').eq('album_id', existingAlbumId).maybeSingle();
          if (existingAlbum.error) throw existingAlbum.error;
          if (!existingAlbum.data) throw new Error('External album ref exists but album not found');
          album = existingAlbum.data;
        } else {
          album = await createAndTrack(
            tracker,
            'albums',
            {
              title: jioAlbum.title,
              description: jioAlbum.description || `Imported from Jio Saavn`,
              cover_url: jioAlbum.image || 'https://via.placeholder.com/300x300?text=Album',
              release_date: jioAlbum.releaseDate || new Date().toISOString().split('T')[0],
              is_published: false, // Keep unpublished until all tracks are processed
              settings: { jio_saavn_id: jioSaavnAlbumId }
            },
            'album_id'
          );
        }

        logger.info(`[ImportService] Created album: ${album.album_id || album.id}`);

        await upsertExternalRef({
          refTable: 'album_external_refs',
          entityIdColumn: 'album_id',
          entityId: album.album_id || album.id,
          providerId,
          externalId: jioSaavnAlbumId,
          externalUrl: jioAlbum.perma_url || null,
          imageUrl: jioAlbum.image || null,
          rawPayload: jioAlbum,
        });

        // Link artist to album
        await supabaseAdmin
          .from('albums_artists')
          .insert({
            album_id: album.album_id || album.id,
            artist_id: artist.artist_id || artist.id,
            role: 'owner'
          });

        logger.debug(`[ImportService] Linked artist to album`);

        // Step 4: Create tracks
        logger.info(`[ImportService] Processing ${jioAlbum.tracks.length} tracks`);

        const importedTracks = [];
        for (let i = 0; i < jioAlbum.tracks.length; i++) {
          const jioTrack = jioAlbum.tracks[i];

          try {
            logger.debug(
              `[ImportService] Import track [${i + 1}/${jioAlbum.tracks.length}]: ${jioTrack.title}`
            );

            // Encrypt the download URL before sending to backend
            const encryptedUrl = encryptionUtil.encryptData(jioTrack.downloadUrl || '');

            // Create track record
            const normalizedLanguageCode = normalizeLanguageCode(jioAlbum.language);
            await ensureLanguageExists(
              normalizedLanguageCode,
              languageNameFromCodeOrInput(normalizedLanguageCode, jioAlbum.language)
            );

            const existingTrackId = await findEntityIdByExternalId({
              refTable: 'track_external_refs',
              entityIdColumn: 'track_id',
              providerId,
              externalId: jioTrack.id,
            });

            let track;
            if (existingTrackId) {
              const existingTrack = await supabaseAdmin.from('tracks').select('*').eq('track_id', existingTrackId).maybeSingle();
              if (existingTrack.error) throw existingTrack.error;
              if (!existingTrack.data) throw new Error('External track ref exists but track not found');
              track = existingTrack.data;
            } else {
              track = await createAndTrack(
                tracker,
                'tracks',
                {
                  album_id: album.album_id || album.id,
                  title: jioTrack.title,
                  duration: jioTrack.duration,
                  language_code: normalizedLanguageCode,
                  is_explicit: jioTrack.explicit || false,
                  is_published: false,
                  track_number: jioTrack.trackNumber || i + 1,
                  settings: { jio_saavn_id: jioTrack.id, encrypted_download_url: encryptedUrl }
                },
                'track_id'
              );
            }

            await upsertExternalRef({
              refTable: 'track_external_refs',
              entityIdColumn: 'track_id',
              entityId: track.track_id || track.id,
              providerId,
              externalId: jioTrack.id,
              externalUrl: jioTrack.perma_url || null,
              imageUrl: jioAlbum.image || null,
              rawPayload: jioTrack,
              extra: {
                external_album_id: jioSaavnAlbumId,
                language: jioAlbum.language || null,
                release_date: jioAlbum.releaseDate || null,
                encrypted_media_url: jioTrack.downloadUrl || null,
              },
            });

            logger.debug(`[ImportService] Created track: ${track.track_id || track.id}`);

            // Link artists to track
            for (const jioArtist of jioTrack.artists) {
              // Find or create artist for this track
              const trackArtist = await supabaseAdmin
                .from('artists')
                .select('artist_id')
                .ilike('name', jioArtist.name)
                .maybeSingle();

              if (trackArtist.data) {
                await supabaseAdmin
                  .from('tracks_artists')
                  .insert({
                    track_id: track.track_id || track.id,
                    artist_id: trackArtist.data.artist_id,
                    role: jioArtist.role || 'primary'
                  });

                logger.debug(`[ImportService] Linked artist ${jioArtist.name} to track`);
              }
            }

            // Also link primary album artist
            await supabaseAdmin
              .from('tracks_artists')
              .insert({
                track_id: track.track_id || track.id,
                artist_id: artist.artist_id || artist.id,
                role: 'owner'
              });

            importedTracks.push(track);

            logger.info(`[ImportService] Track imported successfully: ${jioTrack.title}`);
          } catch (trackError) {
            logger.error(`[ImportService] Failed to import track ${jioTrack.title}:`, trackError);
            throw trackError; // Will trigger rollback
          }
        }

        // Step 5: Publish album if requested
        if (isPublished && importedTracks.length > 0) {
          logger.info(`[ImportService] Publishing album`);

          await updateAndTrack(
            tracker,
            'albums',
            { is_published: true },
            'album_id',
            album.album_id || album.id
          );
        }

        logger.info(
          `[ImportService] Album import completed: ${importedTracks.length} tracks imported`
        );

        return {
          artist,
          album,
          tracksImported: importedTracks.length,
          sessionId
        };
      },
      {
        dryRun,
        operationName: `Import Album: ${jioSaavnAlbumId} - Session: ${sessionId}`
      }
    );

    // Update audit log with final status
    if (auditLogId && result.success) {
      await updateAuditLogStatus(auditLogId, 'success', {
        artist_id: result.data.artist.artist_id || result.data.artist.id,
        album_id: result.data.album.album_id || result.data.album.id,
        tracks_count: result.data.tracksImported,
        dry_run: result.dryRun
      });
    }

    if (result.success) {
      logger.info(`[ImportController] Album import successful: Session ${sessionId}`);
      return res.status(200).json({
        success: true,
        sessionId,
        ...result.data,
        message: result.dryRun ? 'DRY RUN - No changes were committed' : 'Album imported successfully'
      });
    } else {
      logger.error(`[ImportController] Album import failed: Session ${sessionId}`);

      if (auditLogId) {
        await updateAuditLogStatus(auditLogId, 'failed', {
          error: result.error,
          transaction_summary: result.transaction
        });
      }

      return res.status(500).json({
        success: false,
        error: result.error,
        sessionId,
        transaction: result.transaction
      });
    }
  } catch (error) {
    logger.error('[ImportController] Import album exception:', error);

    if (auditLogId) {
      await updateAuditLogStatus(auditLogId, 'failed', {
        error: error.message,
        stack: error.stack
      });
    }

    res.status(500).json({
      error: error.message,
      sessionId
    });
  }
}

/**
 * Begin decryption of track URL for backend processing
 * POST /api/admin/import/decrypt-and-process
 *
 * Request Body:
 * {
 *   trackId: UUID,
 *   encryptedUrl: string
 * }
 */
async function decryptAndProcessTrack(req, res) {
  try {
    const { trackId, encryptedUrl } = req.body;

    if (!trackId || !encryptedUrl) {
      return res.status(400).json({
        error: 'trackId and encryptedUrl are required'
      });
    }

    logger.info(`[ImportController] Decrypting and processing track: ${trackId}`);

    // Decrypt URL
    const decryptedUrl = encryptionUtil.decryptData(encryptedUrl);

    logger.debug(`[ImportController] URL decrypted successfully for track: ${trackId}`);

    // URL is now available for server-side download and audio processing
    // Next steps would be handled by existing track processing pipeline
    res.status(200).json({
      success: true,
      trackId,
      message: 'URL decrypted. Track ready for audio processing'
    });
  } catch (error) {
    logger.error('[ImportController] Decrypt and process failed:', error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  searchTracks,
  getTrackDetails,
  searchAlbums,
  getAlbumDetails,
  searchArtists,
  getArtistDetails,
  importCompleteAlbum,
  decryptAndProcessTrack
};
