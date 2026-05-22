require('dotenv').config();
const { supabaseAdmin } = require('../src/db/config');

async function run() {
  console.log('Fetching all albums from database...');
  const { data: albums, error: albumErr } = await supabaseAdmin
    .from('albums')
    .select('album_id, title, total_tracks, duration');

  if (albumErr) {
    console.error('Error fetching albums:', albumErr);
    return;
  }

  console.log(`Found ${albums.length} albums. Recalculating stats...`);

  for (const album of albums) {
    // Fetch all tracks for this album
    const { data: tracks, error: trackErr } = await supabaseAdmin
      .from('tracks')
      .select('duration')
      .eq('album_id', album.album_id);

    if (trackErr) {
      console.error(`Error fetching tracks for album ${album.title || album.album_id}:`, trackErr);
      continue;
    }

    const actualCount = tracks.length;
    const actualDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);

    if (album.total_tracks !== actualCount || album.duration !== actualDuration) {
      console.log(`Updating "${album.title}" (ID: ${album.album_id}):`);
      console.log(`  - total_tracks: ${album.total_tracks} -> ${actualCount}`);
      console.log(`  - duration: ${album.duration} -> ${actualDuration}`);

      const { error: updateErr } = await supabaseAdmin
        .from('albums')
        .update({
          total_tracks: actualCount,
          duration: actualDuration
        })
        .eq('album_id', album.album_id);

      if (updateErr) {
        console.error(`  ❌ Error updating album ${album.title}:`, updateErr.message || updateErr);
      } else {
        console.log(`  ✅ Successfully updated`);
      }
    }
  }

  console.log('\nRecalculation complete!');
}

run().catch(console.error);
