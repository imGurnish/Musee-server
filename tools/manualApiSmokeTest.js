/* eslint-disable no-console */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { createClient } = require('@supabase/supabase-js');
const { supabaseAdmin, blobServiceClient, containerName } = require('../src/db/config');

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:8080';
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || '');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rand(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

async function request(method, urlPath, { token, json, formData } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const normalizedMethod = String(method || '').toUpperCase();
  const canHaveBody = normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD';
  let body;
  if (canHaveBody && json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (canHaveBody && formData) {
    body = formData;
  }

  const res = await fetch(`${BASE_URL}${urlPath}`, { method, headers, body });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

function logPass(name, extra = '') {
  console.log(`✅ ${name}${extra ? ` -> ${extra}` : ''}`);
}

function logFail(name, err) {
  console.error(`❌ ${name}: ${err.message}`);
}

function expectStatus(name, actual, expectedSet) {
  const ok = expectedSet.includes(actual);
  assert(ok, `${name} expected status ${expectedSet.join('/')} got ${actual}`);
}

function createTestWav(outPath) {
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:sample_rate=44100:duration=1',
    '-ac', '2',
    outPath,
  ];
  const run = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`ffmpeg failed: ${run.stderr || run.stdout}`);
  }
  assert(fs.existsSync(outPath), 'wav test file not created');
}

async function blobExists(blobName) {
  if (!blobServiceClient) return false;
  const container = blobServiceClient.getContainerClient(containerName);
  const client = container.getBlobClient(blobName);
  return client.exists();
}

async function listBlobsByPrefix(prefix, max = 10) {
  if (!blobServiceClient) return [];
  const container = blobServiceClient.getContainerClient(containerName);
  const names = [];
  for await (const b of container.listBlobsFlat({ prefix })) {
    names.push(b.name);
    if (names.length >= max) break;
  }
  return names;
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

async function getAvailableCountryCode() {
  const existing = await supabaseAdmin.from('countries').select('code');
  if (existing.error) throw existing.error;
  const used = new Set((existing.data || []).map((row) => String(row.code || '').toUpperCase()));
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = `${String.fromCharCode(a)}${String.fromCharCode(b)}`;
      if (!used.has(code)) return code;
    }
  }
  throw new Error('no available 2-letter country code found for smoke test');
}

async function run() {
  const createdAuthIds = [];
  const created = {
    planId: null,
    countryId: null,
    regionId: null,
    albumId: null,
    trackId: null,
    playlistId: null,
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musee-smoke-'));
  const wavPath = path.join(tempDir, 'tone.wav');

  try {
    const health = await request('GET', '/health');
    expectStatus('health', health.status, [200, 500]);
    logPass('health endpoint reachable', String(health.status));

    createTestWav(wavPath);
    logPass('audio fixture generated', wavPath);

    const adminEmail = `${rand('admin')}@example.com`;
    const userEmail = `${rand('user')}@example.com`;
    const password = 'Passw0rd!123456';

    const admin = await createAuthAndUser({ email: adminEmail, password, name: 'Smoke Admin', userType: 'admin' });
    const user = await createAuthAndUser({ email: userEmail, password, name: 'Smoke User', userType: 'listener' });
    createdAuthIds.push(admin.id, user.id);

    logPass('auth bootstrap complete');

    // Plans
    {
      const noAuth = await request('GET', '/api/admin/plans');
      expectStatus('admin plans no auth', noAuth.status, [401]);
      logPass('admin plans unauthorized validation');

      const listUser = await request('GET', '/api/user/plans', { token: user.token });
      expectStatus('user plans list', listUser.status, [200]);
      logPass('user plans list');

      const invalidCreate = await request('POST', '/api/admin/plans', {
        token: admin.token,
        json: { name: rand('plan'), price: -1, currency: 'INR', billing_cycle: 'monthly' },
      });
      expectStatus('admin plan invalid create', invalidCreate.status, [400]);
      logPass('admin plan invalid create');

      const validCreate = await request('POST', '/api/admin/plans', {
        token: admin.token,
        json: { name: rand('plan'), price: 99, currency: 'INR', billing_cycle: 'monthly', max_devices: 2 },
      });
      expectStatus('admin plan create', validCreate.status, [201]);
      created.planId = validCreate.body.plan_id;
      logPass('admin plan create', created.planId);

      const invalidId = await request('PATCH', '/api/admin/plans/not-a-uuid', {
        token: admin.token,
        json: { price: 120 },
      });
      expectStatus('admin plan invalid id', invalidId.status, [400]);
      logPass('admin plan invalid id validation');
    }

    // Country + Region (optional module; skip if table not present in current schema)
    {
      const probe = await request('GET', '/api/admin/countries', { token: admin.token });
      const tableMissing = probe.status === 500 && probe.body && typeof probe.body.error === 'string' && probe.body.error.includes("Could not find the table 'public.countries'");

      if (tableMissing) {
        console.log('⚠️  countries/regions module skipped: countries table is not present in DB schema');
      } else {
        expectStatus('admin countries list', probe.status, [200]);

        const countryCode = await getAvailableCountryCode();

        const invalidCountry = await request('POST', '/api/admin/countries', {
          token: admin.token,
          json: { code: 'IND', name: 'India' },
        });
        expectStatus('country invalid code', invalidCountry.status, [400]);
        logPass('country invalid code validation');

        const country = await request('POST', '/api/admin/countries', {
          token: admin.token,
          json: { code: countryCode, name: rand('SmokeCountry') },
        });
        expectStatus('country create', country.status, [201]);
        created.countryId = country.body.country_id;
        logPass('country create', created.countryId);

        const regionInvalid = await request('POST', '/api/admin/regions', {
          token: admin.token,
          json: { code: 'XX-01', name: 'Invalid region', country_id: 'bad' },
        });
        expectStatus('region invalid country id', regionInvalid.status, [400]);
        logPass('region invalid input validation');

        const region = await request('POST', '/api/admin/regions', {
          token: admin.token,
          json: { code: 'IN-MH', name: rand('Maharashtra'), country_id: created.countryId },
        });
        expectStatus('region create', region.status, [201]);
        created.regionId = region.body.region_id;
        logPass('region create', created.regionId);

        const userInvalidId = await request('GET', '/api/user/regions/not-a-uuid', { token: user.token });
        expectStatus('user region invalid id', userInvalidId.status, [400]);
        logPass('user region invalid id validation');
      }
    }

    // Artist create + duplicate handling
    {
      const artistBad = await request('POST', '/api/user/artists', {
        token: user.token,
        json: { social_links: {} },
      });
      expectStatus('artist invalid create (missing bio)', artistBad.status, [400]);
      logPass('artist required-field validation');

      const artistOk = await request('POST', '/api/user/artists', {
        token: user.token,
        json: { bio: 'Smoke artist bio', ...(created.regionId ? { region_id: created.regionId } : {}), debut_year: 2020 },
      });
      expectStatus('artist create', artistOk.status, [201]);
      logPass('artist create', artistOk.body.artist_id);

      const artistDup = await request('POST', '/api/user/artists', {
        token: user.token,
        json: { bio: 'Duplicate profile' },
      });
      expectStatus('artist duplicate create', artistDup.status, [409]);
      logPass('artist duplicate create validation');
    }

    // Albums
    {
      const badAlbum = await request('POST', '/api/user/albums', {
        token: user.token,
        json: { description: 'missing title' },
      });
      expectStatus('album invalid create', badAlbum.status, [400]);
      logPass('album required-field validation');

      const goodAlbum = await request('POST', '/api/user/albums', {
        token: user.token,
        json: { title: rand('Smoke Album'), description: 'Album for smoke test', is_published: false },
      });
      expectStatus('album create', goodAlbum.status, [201]);
      created.albumId = goodAlbum.body.album_id;
      logPass('album create', created.albumId);

      const badField = await request('PATCH', `/api/user/albums/${created.albumId}`, {
        token: user.token,
        json: { unknown_field: true },
      });
      expectStatus('album forbidden field', badField.status, [403]);
      logPass('album forbidden field validation');
    }

    // Tracks + audio upload + integrity checks
    {
      const noAudio = await request('POST', '/api/user/tracks', {
        token: user.token,
        json: { title: rand('Track No Audio'), album_id: created.albumId, duration: 10 },
      });
      expectStatus('track create without audio', noAudio.status, [400]);
      logPass('track audio required validation');

      const fd = new FormData();
      fd.append('title', rand('Smoke Track'));
      fd.append('album_id', created.albumId);
      fd.append('duration', '10');
      fd.append('is_explicit', 'false');
      const audioBlob = new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' });
      fd.append('audio', audioBlob, 'tone.wav');

      const withAudio = await request('POST', '/api/user/tracks', { token: user.token, formData: fd });
      expectStatus('track create with audio', withAudio.status, [201]);
      created.trackId = withAudio.body.track_id;
      logPass('track create with audio', created.trackId);

      const assets = await supabaseAdmin
        .from('track_assets')
        .select('*')
        .eq('track_id', created.trackId)
        .eq('asset_type', 'audio_progressive');
      if (assets.error) throw assets.error;
      assert((assets.data || []).length > 0, 'expected audio track_assets row');
      logPass('track_assets row created', String(assets.data.length));

      const artistLink = await supabaseAdmin
        .from('track_artists')
        .select('*')
        .eq('track_id', created.trackId)
        .eq('artist_id', user.id)
        .eq('role', 'owner')
        .maybeSingle();
      if (artistLink.error) throw artistLink.error;
      assert(!!artistLink.data, 'expected track owner link in track_artists');
      logPass('track owner link consistency');

      const oneAsset = assets.data[0];
      const assetBlobExists = await blobExists(oneAsset.file_path);
      assert(assetBlobExists, `audio blob missing: ${oneAsset.file_path}`);
      logPass('audio blob exists', oneAsset.file_path);

      const hlsBlobs = await listBlobsByPrefix(`hls/track_${created.trackId}/`, 5);
      assert(hlsBlobs.length > 0, 'expected HLS blobs under track prefix');
      logPass('hls blob tree exists', `${hlsBlobs.length}+ files`);
    }

    // Playlists + membership integrity
    {
      const playlist = await request('POST', '/api/user/playlists', {
        token: user.token,
        json: { name: rand('Smoke Playlist'), description: 'desc', is_public: true },
      });
      if (playlist.status === 201) {
        created.playlistId = playlist.body.playlist_id;
        logPass('playlist create', created.playlistId);
      } else if (playlist.status === 409) {
        const existingPlaylist = await supabaseAdmin
          .from('playlists')
          .select('playlist_id')
          .eq('creator_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existingPlaylist.error) throw existingPlaylist.error;
        assert(existingPlaylist.data?.playlist_id, `playlist create conflict without existing playlist: ${JSON.stringify(playlist.body)}`);
        created.playlistId = existingPlaylist.data.playlist_id;
        console.log(`⚠️  playlist create conflict; reusing existing playlist -> ${created.playlistId}`);
      } else {
        expectStatus('playlist create', playlist.status, [201]);
      }

      const addInvalidTrack = await request('POST', `/api/user/playlists/${created.playlistId}/tracks`, {
        token: user.token,
        json: { track_id: 'bad-id' },
      });
      expectStatus('playlist add invalid track id', addInvalidTrack.status, [400]);
      logPass('playlist add invalid track id validation');

      const addTrack = await request('POST', `/api/user/playlists/${created.playlistId}/tracks`, {
        token: user.token,
        json: { track_id: created.trackId },
      });
      expectStatus('playlist add track', addTrack.status, [200]);
      logPass('playlist add track');

      const ptrack = await supabaseAdmin
        .from('playlist_tracks')
        .select('*')
        .eq('playlist_id', created.playlistId)
        .eq('track_id', created.trackId)
        .maybeSingle();
      if (ptrack.error) throw ptrack.error;
      assert(!!ptrack.data, 'expected playlist_tracks row');
      assert(ptrack.data.position === 1, `expected playlist track position=1 got ${ptrack.data.position}`);
      assert(ptrack.data.added_by === user.id, 'expected added_by to be current user');
      logPass('playlist_tracks consistency (position, added_by)');
    }

    // Follow system integrity
    {
      const invalidStatus = await request('GET', '/api/user/follows/status/not-a-uuid', { token: user.token });
      expectStatus('follow status invalid id', invalidStatus.status, [400]);
      logPass('follow status invalid id validation');

      const followAdmin = await request('POST', `/api/user/follows/${admin.id}`, { token: user.token });
      expectStatus('follow admin', followAdmin.status, [200]);
      logPass('follow admin');

      const countsAfterFollow = await supabaseAdmin
        .from('users')
        .select('user_id, followers_count, followings_count')
        .in('user_id', [user.id, admin.id]);
      if (countsAfterFollow.error) throw countsAfterFollow.error;
      const uMap = new Map((countsAfterFollow.data || []).map((r) => [r.user_id, r]));
      assert((uMap.get(user.id)?.followings_count || 0) >= 1, 'expected user followings_count incremented');
      assert((uMap.get(admin.id)?.followers_count || 0) >= 1, 'expected admin followers_count incremented');
      logPass('follow counter consistency');

      const unfollowAdmin = await request('DELETE', `/api/user/follows/${admin.id}`, { token: user.token });
      expectStatus('unfollow admin', unfollowAdmin.status, [200]);
      logPass('unfollow admin');
    }

    // invalid id checks on key CRUD routes
    {
      const checks = [
        ['GET', '/api/admin/users/not-a-uuid', admin.token],
        ['PATCH', '/api/admin/albums/not-a-uuid', admin.token],
        ['DELETE', '/api/admin/tracks/not-a-uuid', admin.token],
        ['GET', '/api/user/artists/not-a-uuid', user.token],
        ['PATCH', '/api/user/tracks/not-a-uuid', user.token],
        ['DELETE', '/api/user/playlists/not-a-uuid', user.token],
      ];
      for (const [m, p, t] of checks) {
        const res = await request(m, p, { token: t, json: {} });
        expectStatus(`invalid id ${m} ${p}`, res.status, [400]);
      }
      logPass('invalid-id smoke checks across CRUD groups');
    }

    console.log('\n🎉 SMOKE TEST RESULT: PASS');
  } finally {
    try {
      if (created.trackId) await supabaseAdmin.from('tracks').delete().eq('track_id', created.trackId);
      if (created.playlistId) await supabaseAdmin.from('playlists').delete().eq('playlist_id', created.playlistId);
      if (created.albumId) await supabaseAdmin.from('albums').delete().eq('album_id', created.albumId);
      if (created.regionId) await supabaseAdmin.from('regions').delete().eq('region_id', created.regionId);
      if (created.countryId) await supabaseAdmin.from('countries').delete().eq('country_id', created.countryId);
      if (created.planId) await supabaseAdmin.from('plans').delete().eq('plan_id', created.planId);
    } catch (cleanupErr) {
      console.warn('cleanup warning:', cleanupErr.message || cleanupErr);
    }

    for (const id of createdAuthIds) {
      try { await supabaseAdmin.auth.admin.deleteUser(id); } catch (_) { }
      try { await supabaseAdmin.from('users').delete().eq('user_id', id); } catch (_) { }
    }

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { }
  }
}

run().catch((e) => {
  console.error('\n💥 SMOKE TEST RESULT: FAIL');
  console.error(e);
  process.exit(1);
});
