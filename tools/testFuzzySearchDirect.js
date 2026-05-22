require('dotenv').config();
const { listTracksUser } = require('../src/models/trackModel');
const { listAlbumsUser } = require('../src/models/albumModel');
const { listArtistsUser } = require('../src/models/artistModel');
const { listPlaylistsUser } = require('../src/models/playlistModel');

async function run() {
  console.log('\n=========================================');
  console.log('🧪 RUNNING FUZZY SEARCH DIRECT MODEL TESTS');
  console.log('=========================================\n');

  // Test Case 1: Fuzzy Track Search ('shda' -> 'Shada' or 'suprem' -> 'Supreme')
  try {
    console.log('1. Testing fuzzy track search with typo "shda"...');
    const tracksRes = await listTracksUser({ q: 'shda', limit: 3 });
    console.log(`   - Found ${tracksRes.items.length} matches (total: ${tracksRes.total})`);
    console.log('   - Titles:', tracksRes.items.map(t => t.title));
  } catch (err) {
    console.error('   ❌ Failed:', err.message || err);
  }

  try {
    console.log('2. Testing fuzzy track search with typo "suprem"...');
    const tracksRes2 = await listTracksUser({ q: 'suprem', limit: 3 });
    console.log(`   - Found ${tracksRes2.items.length} matches (total: ${tracksRes2.total})`);
    console.log('   - Titles:', tracksRes2.items.map(t => t.title));
  } catch (err) {
    console.error('   ❌ Failed:', err.message || err);
  }

  // Test Case 2: Fuzzy Album Search ('so hgh' -> 'So High')
  try {
    console.log('\n3. Testing fuzzy album search with typo "so hgh"...');
    const albumsRes = await listAlbumsUser({ q: 'so hgh', limit: 3 });
    console.log(`   - Found ${albumsRes.items.length} matches (total: ${albumsRes.total})`);
    console.log('   - Titles:', albumsRes.items.map(a => a.title));
  } catch (err) {
    console.error('   ❌ Failed:', err.message || err);
  }

  // Test Case 3: Fuzzy Artist Search ('guru randawa' -> 'Guru Randhawa')
  try {
    console.log('\n4. Testing fuzzy artist search with typo "guru randawa"...');
    const artistsRes = await listArtistsUser({ q: 'guru randawa', limit: 3 });
    console.log(`   - Found ${artistsRes.items.length} matches (total: ${artistsRes.total})`);
    console.log('   - Names:', artistsRes.items.map(a => a.name));
  } catch (err) {
    console.error('   ❌ Failed:', err.message || err);
  }

  // Test Case 4: Prefix Artist Search ('gippy' -> 'Gippy Grewal')
  try {
    console.log('\n5. Testing prefix artist search with "gippy"...');
    const artistsRes2 = await listArtistsUser({ q: 'gippy', limit: 3 });
    console.log(`   - Found ${artistsRes2.items.length} matches (total: ${artistsRes2.total})`);
    console.log('   - Names:', artistsRes2.items.map(a => a.name));
  } catch (err) {
    console.error('   ❌ Failed:', err.message || err);
  }
}

run();
