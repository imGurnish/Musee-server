/**
 * Jio Saavn API Client
 * Provides methods to search and fetch track, album, and artist data from Jio Saavn
 * Dependencies: axios
 */

const axios = require('axios');
const logger = require('./logger');

const JIO_SAAVN_BASE_URL = process.env.JIO_SAAVN_API_URL || 'https://www.jiosaavn.com/api.php';
const JIO_SAAVN_SEARCH_URL = process.env.JIO_SAAVN_SEARCH_URL || 'https://www.jiosaavn.com/api.php';

const client = axios.create({
  baseURL: JIO_SAAVN_BASE_URL,
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

/**
 * Search for tracks on Jio Saavn
 * @param {string} query - Search query (artist, track name, album)
 * @param {number} limit - Max results (default 10)
 * @returns {Promise<Array>} Array of track results
 */
async function searchTracks(query, limit = 10) {
  try {
    logger.info(`[Jio Saavn] Searching tracks: "${query}"`);
    
    const response = await client.get('/', {
      params: {
        __call: 'autocomplete.get',
        _format: 'json',
        query: query,
        count: limit
      }
    });

    if (!response.data || !response.data.songs) {
      logger.warn(`[Jio Saavn] No tracks found for: "${query}"`);
      return [];
    }

    const tracks = response.data.songs.map(song => ({
      id: song.id,
      title: song.title || song.song,
      artists: parseArtists(song),
      album: {
        id: song.album_id,
        title: song.album,
        image: song.image
      },
      duration: parseInt(song.duration) || 0,
      language: song.language || 'en',
      year: parseInt(song.year) || new Date().getFullYear(),
      explicit: song.explicit_content === '1',
      downloadUrl: song.download_url || null,
      primaryArtist: song.primary_artists ? parseArtists(song.primary_artists) : []
    }));

    logger.debug(`[Jio Saavn] Found ${tracks.length} tracks`);
    return tracks;
  } catch (error) {
    logger.error('[Jio Saavn] Track search failed:', error.message);
    throw new Error(`Failed to search tracks: ${error.message}`);
  }
}

/**
 * Get detailed track information
 * @param {string} trackId - Jio Saavn track ID
 * @returns {Promise<Object>} Detailed track object
 */
async function getTrack(trackId) {
  try {
    logger.info(`[Jio Saavn] Fetching track: ${trackId}`);
    
    const response = await client.get('/', {
      params: {
        __call: 'song.getDetails',
        _format: 'json',
        cc: 'in',
        includeRelated: false,
        pid: trackId
      }
    });

    if (!response.data) {
      throw new Error('No track data returned');
    }

    const song = response.data;
    const track = {
      id: song.id,
      title: song.title || song.song,
      artists: parseArtists(song),
      album: {
        id: song.album_id,
        title: song.album,
        image: song.image
      },
      duration: parseInt(song.duration) || 0,
      language: song.language || 'en',
      year: parseInt(song.year) || new Date().getFullYear(),
      explicit: song.explicit_content === '1',
      downloadUrl: song.download_url || null,
      lyrics: song.lyrics_url || null,
      copyright: song.copyright_text || null,
      primaryArtist: song.primary_artists ? parseArtists({primary_artists: song.primary_artists})[0] : null
    };

    logger.debug(`[Jio Saavn] Retrieved track: ${track.title}`);
    return track;
  } catch (error) {
    logger.error('[Jio Saavn] Failed to get track details:', error.message);
    throw new Error(`Failed to get track: ${error.message}`);
  }
}

/**
 * Search for albums
 * @param {string} query - Album name or artist
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Array of album results
 */
async function searchAlbums(query, limit = 10) {
  try {
    logger.info(`[Jio Saavn] Searching albums: "${query}"`);
    
    const response = await client.get('/', {
      params: {
        __call: 'autocomplete.get',
        _format: 'json',
        query: query,
        count: limit
      }
    });

    if (!response.data || !response.data.albums) {
      logger.warn(`[Jio Saavn] No albums found for: "${query}"`);
      return [];
    }

    const albums = response.data.albums.map(album => ({
      id: album.id,
      title: album.title,
      artists: parseArtists(album),
      image: album.image,
      year: parseInt(album.year) || new Date().getFullYear(),
      language: album.language || 'en',
      songCount: parseInt(album.songCount) || 0
    }));

    logger.debug(`[Jio Saavn] Found ${albums.length} albums`);
    return albums;
  } catch (error) {
    logger.error('[Jio Saavn] Album search failed:', error.message);
    throw new Error(`Failed to search albums: ${error.message}`);
  }
}

/**
 * Get detailed album information with all tracks
 * @param {string} albumId - Jio Saavn album ID
 * @returns {Promise<Object>} Detailed album with tracks
 */
async function getAlbum(albumId) {
  try {
    logger.info(`[Jio Saavn] Fetching album: ${albumId}`);
    
    const response = await client.get('/', {
      params: {
        __call: 'album.getDetails',
        _format: 'json',
        cc: 'in',
        albumid: albumId
      }
    });

    if (!response.data) {
      throw new Error('No album data returned');
    }

    const album = response.data;
    const tracks = (album.songs || []).map(song => ({
      id: song.id,
      title: song.title || song.song,
      artists: parseArtists(song),
      duration: parseInt(song.duration) || 0,
      trackNumber: parseInt(song.position) || 0,
      explicit: song.explicit_content === '1',
      downloadUrl: song.download_url || null
    }));

    const result = {
      id: album.id,
      title: album.title,
      artists: parseArtists(album),
      image: album.image,
      year: parseInt(album.year) || new Date().getFullYear(),
      language: album.language || 'en',
      releaseDate: album.release_date || null,
      description: album.description || null,
      tracks: tracks
    };

    logger.debug(`[Jio Saavn] Retrieved album: ${result.title} with ${tracks.length} tracks`);
    return result;
  } catch (error) {
    logger.error('[Jio Saavn] Failed to get album details:', error.message);
    throw new Error(`Failed to get album: ${error.message}`);
  }
}

/**
 * Search for artists
 * @param {string} query - Artist name
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Array of artist results
 */
async function searchArtists(query, limit = 10) {
  try {
    logger.info(`[Jio Saavn] Searching artists: "${query}"`);
    
    const response = await client.get('/', {
      params: {
        __call: 'autocomplete.get',
        _format: 'json',
        query: query,
        count: limit
      }
    });

    if (!response.data || !response.data.artists) {
      logger.warn(`[Jio Saavn] No artists found for: "${query}"`);
      return [];
    }

    const artists = response.data.artists.map(artist => ({
      id: artist.id,
      name: artist.name,
      image: artist.image,
      bio: artist.bio || null,
      language: artist.language || 'en'
    }));

    logger.debug(`[Jio Saavn] Found ${artists.length} artists`);
    return artists;
  } catch (error) {
    logger.error('[Jio Saavn] Artist search failed:', error.message);
    throw new Error(`Failed to search artists: ${error.message}`);
  }
}

/**
 * Get detailed artist information
 * @param {string} artistId - Jio Saavn artist ID
 * @returns {Promise<Object>} Detailed artist object
 */
async function getArtist(artistId) {
  try {
    logger.info(`[Jio Saavn] Fetching artist: ${artistId}`);
    
    const response = await client.get('/', {
      params: {
        __call: 'artist.getDetails',
        _format: 'json',
        cc: 'in',
        artistid: artistId
      }
    });

    if (!response.data) {
      throw new Error('No artist data returned');
    }

    const artist = response.data;
    const topSongs = (artist.topSongs || []).map(song => ({
      id: song.id,
      title: song.title || song.song,
      duration: parseInt(song.duration) || 0
    })) || [];

    const result = {
      id: artist.id,
      name: artist.name,
      image: artist.image,
      bio: artist.bio || null,
      language: artist.language || 'en',
      followerCount: parseInt(artist.followerCount) || 0,
      topSongs: topSongs
    };

    logger.debug(`[Jio Saavn] Retrieved artist: ${result.name}`);
    return result;
  } catch (error) {
    logger.error('[Jio Saavn] Failed to get artist details:', error.message);
    throw new Error(`Failed to get artist: ${error.message}`);
  }
}

/**
 * Helper function to parse artist information from Jio Saavn objects
 * @param {Object} data - Jio Saavn object with artist info
 * @returns {Array} Array of parsed artists
 */
function parseArtists(data) {
  const artistStrings = data.primary_artists || data.singers || data.artists || '';
  
  if (!artistStrings || typeof artistStrings !== 'string') {
    return [];
  }

  return artistStrings
    .split(',')
    .map(name => ({
      name: (name || '').trim(),
      role: 'primary'
    }))
    .filter(a => a.name.length > 0);
}

module.exports = {
  searchTracks,
  getTrack,
  searchAlbums,
  getAlbum,
  searchArtists,
  getArtist,
  parseArtists
};
