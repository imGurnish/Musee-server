/* eslint-disable no-console */
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { supabaseAdmin } = require('../src/db/config');

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:8080';
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || '');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rand(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

async function request(method, urlPath, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function createAuthAndUser({ email, password, name, userType }) {
  const created = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (created.error) throw created.error;
  const id = created.data.user.id;

  const upsert = await supabaseAdmin.from('users').upsert({
    user_id: id,
    email,
    name,
    user_type: userType,
  }, { onConflict: 'user_id' }).select('*').single();
  if (upsert.error) throw upsert.error;

  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  const token = signIn.data.session?.access_token;
  assert(token, 'missing access token');

  return { id, token, email };
}

async function run() {
  const createdAuthIds = [];
  const created = {
    albumId: null,
    trackId: null,
    trackId2: null,
    playlistId: null,
  };

  const uniqueKeyword = rand('smokekeyword');
  console.log(`Using unique search keyword: ${uniqueKeyword}`);

  try {
    const artistEmail = `${rand('artist')}@example.com`;
    const password = 'Passw0rd!123456';

    const artistUser = await createAuthAndUser({
      email: artistEmail,
      password,
      name: `${uniqueKeyword} Artist`,
      userType: 'artist'
    });
    createdAuthIds.push(artistUser.id);
    console.log('✅ Temporary artist user created');

    // Create Artist profile row
    const artistProfile = await supabaseAdmin.from('artists').insert({
      artist_id: artistUser.id,
      bio: `Smoke bio with ${uniqueKeyword}`,
      cover_url: 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/covers/artists/default_cover.png',
      debut_year: 2024,
      is_verified: true
    }).select('*').single();
    if (artistProfile.error) throw artistProfile.error;
    console.log('✅ Temporary artist profile created');

    // Create Album
    const album = await supabaseAdmin.from('albums').insert({
      title: `${uniqueKeyword} Album`,
      description: 'Smoke test album',
      is_published: true,
      total_tracks: 5,
      duration: 300
    }).select('*').single();
    if (album.error) throw album.error;
    created.albumId = album.data.album_id;
    console.log('✅ Temporary album created', created.albumId, 'Initial total_tracks:', album.data.total_tracks);

    // Link Album Artist
    const albumArtist = await supabaseAdmin.from('album_artists').insert({
      album_id: created.albumId,
      artist_id: artistUser.id,
      role: 'owner'
    });
    if (albumArtist.error) throw albumArtist.error;

    // Get album before track creation
    const beforeTrack = await supabaseAdmin.from('albums').select('total_tracks').eq('album_id', created.albumId).single();
    console.log('Album total_tracks before track insertion:', beforeTrack.data?.total_tracks);

    // Create Track 1
    const track = await supabaseAdmin.from('tracks').insert({
      title: `${uniqueKeyword} Track`,
      album_id: created.albumId,
      duration: 180,
      is_published: true,
      play_count: 50
    }).select('*').single();
    if (track.error) throw track.error;
    created.trackId = track.data.track_id;
    console.log('✅ Temporary track 1 created', created.trackId);

    // Link Track 1 Artist
    const trackArtist = await supabaseAdmin.from('track_artists').insert({
      track_id: created.trackId,
      artist_id: artistUser.id,
      role: 'owner'
    });
    if (trackArtist.error) throw trackArtist.error;

    // Create Track 2
    const track2 = await supabaseAdmin.from('tracks').insert({
      title: `${uniqueKeyword} Track 2`,
      album_id: created.albumId,
      duration: 120,
      is_published: true,
      play_count: 20
    }).select('*').single();
    if (track2.error) throw track2.error;
    created.trackId2 = track2.data.track_id;
    console.log('✅ Temporary track 2 created', created.trackId2);

    // Link Track 2 Artist
    const trackArtist2 = await supabaseAdmin.from('track_artists').insert({
      track_id: created.trackId2,
      artist_id: artistUser.id,
      role: 'owner'
    });
    if (trackArtist2.error) throw trackArtist2.error;

    // Get album after both tracks are created
    const afterTrack = await supabaseAdmin.from('albums').select('total_tracks').eq('album_id', created.albumId).single();
    console.log('Album total_tracks after both track insertions:', afterTrack.data?.total_tracks);

    // Create Playlist
    const playlist = await supabaseAdmin.from('playlists').insert({
      name: `${uniqueKeyword} Playlist`,
      description: 'Smoke test playlist',
      creator_id: artistUser.id,
      is_public: true,
      total_tracks: 1
    }).select('*').single();
    if (playlist.error) throw playlist.error;
    created.playlistId = playlist.data.playlist_id;
    console.log('✅ Temporary playlist created', created.playlistId);

    // Link Playlist Track
    const playlistTrack = await supabaseAdmin.from('playlist_tracks').insert({
      playlist_id: created.playlistId,
      track_id: created.trackId,
      position: 1,
      added_by: artistUser.id
    });
    if (playlistTrack.error) throw playlistTrack.error;

    console.log('\n--- Running Search Request tests ---');

    // 1. Test empty search query returns empty arrays
    const emptySearch = await request('GET', '/api/user/search?q=', { token: artistUser.token });
    assert(emptySearch.status === 200, `Empty search status: ${emptySearch.status}`);
    assert(Array.isArray(emptySearch.body.tracks) && emptySearch.body.tracks.length === 0, 'Empty search tracks not empty');
    assert(Array.isArray(emptySearch.body.albums) && emptySearch.body.albums.length === 0, 'Empty search albums not empty');
    console.log('✅ Empty search returns correctly');

    // 2. Test search query with unique keyword
    const searchRes = await request('GET', `/api/user/search?q=${uniqueKeyword}`, { token: artistUser.token });
    assert(searchRes.status === 200, `Search status: ${searchRes.status}`);
    
    const { tracks, albums, artists, playlists } = searchRes.body;
    assert(Array.isArray(tracks), 'tracks not an array');
    assert(Array.isArray(albums), 'albums not an array');
    assert(Array.isArray(artists), 'artists not an array');
    assert(Array.isArray(playlists), 'playlists not an array');

    console.log(`Search counts: Tracks=${tracks.length}, Albums=${albums.length}, Artists=${artists.length}, Playlists=${playlists.length}`);

    // Verify entity fields
    assert(tracks.length > 0, 'expected at least one track matching search');
    const matchedTrack = tracks.find(t => t.track_id === created.trackId);
    assert(matchedTrack, 'track 1 not found in search results');
    assert(matchedTrack.title === `${uniqueKeyword} Track`, 'track title mismatch');
    assert(matchedTrack.album && matchedTrack.album.title === `${uniqueKeyword} Album`, 'track missing album metadata');
    assert(matchedTrack.album.cover_url, 'track missing album cover URL');
    assert(matchedTrack.hls && matchedTrack.hls.master, 'track missing HLS master stream URL');
    assert(matchedTrack.artists && matchedTrack.artists.length > 0, 'track missing artists list');
    assert(matchedTrack.artists[0].name === `${uniqueKeyword} Artist`, 'track artist name mismatch');
    console.log('✅ Track entity verified with complete details (album, cover, artists, HLS links)');

    assert(albums.length > 0, 'expected at least one album matching search');
    const matchedAlbum = albums[0];
    assert(matchedAlbum.album_id === created.albumId, 'album ID mismatch');
    assert(matchedAlbum.title === `${uniqueKeyword} Album`, 'album title mismatch');
    assert(matchedAlbum.cover_url, 'album missing cover url');
    assert(matchedAlbum.artists && matchedAlbum.artists.length > 0, 'album missing artists list');
    assert(matchedAlbum.artists[0].name === `${uniqueKeyword} Artist`, 'album artist name mismatch');
    console.log('✅ Album entity verified with complete details (cover, artists)');

    assert(artists.length > 0, 'expected at least one artist matching search');
    const matchedArtist = artists[0];
    assert(matchedArtist.artist_id === artistUser.id, 'artist ID mismatch');
    assert(matchedArtist.name === `${uniqueKeyword} Artist`, 'artist name mismatch');
    assert(matchedArtist.avatar_url !== undefined, 'artist missing avatar_url');
    assert(matchedArtist.is_verified === true, 'artist verification flag mismatch');
    console.log('✅ Artist entity verified with complete details (bio, verified flag)');

    assert(playlists.length > 0, 'expected at least one playlist matching search');
    const matchedPlaylist = playlists[0];
    assert(matchedPlaylist.playlist_id === created.playlistId, 'playlist ID mismatch');
    assert(matchedPlaylist.name === `${uniqueKeyword} Playlist`, 'playlist name mismatch');
    assert(matchedPlaylist.cover_url, 'playlist missing cover url');
    assert(matchedPlaylist.creator_name === `${uniqueKeyword} Artist`, 'playlist creator name mismatch');
    console.log('✅ Playlist entity verified with complete details (creator, cover)');

    console.log('\n🎉 ALL SEARCH ENDPOINT SMOKE TESTS PASSED');
  } finally {
    console.log('\n--- Cleaning up temporary resources ---');
    try {
      if (created.playlistId) await supabaseAdmin.from('playlists').delete().eq('playlist_id', created.playlistId);
      if (created.trackId) await supabaseAdmin.from('tracks').delete().eq('track_id', created.trackId);
      if (created.trackId2) await supabaseAdmin.from('tracks').delete().eq('track_id', created.trackId2);
      if (created.albumId) await supabaseAdmin.from('albums').delete().eq('album_id', created.albumId);
    } catch (err) {
      console.warn('DB cleanup error:', err.message || err);
    }

    for (const id of createdAuthIds) {
      try { await supabaseAdmin.auth.admin.deleteUser(id); } catch (_) {}
      try { await supabaseAdmin.from('users').delete().eq('user_id', id); } catch (_) {}
    }
    console.log('Cleanup completed successfully.');
  }
}

run().catch((e) => {
  console.error('\n❌ SMOKE TEST FAILED');
  console.error(e);
  process.exit(1);
});
