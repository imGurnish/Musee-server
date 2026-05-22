require('dotenv').config();
const { supabaseAdmin } = require('../src/db/config');

async function run() {
  console.log('Searching for albums matching "Chapter"...');
  const { data: albums, error: albumErr } = await supabaseAdmin
    .from('albums')
    .select('*')
    .ilike('title', '%Chapter%');

  if (albumErr) {
    console.error('Error fetching albums:', albumErr);
    return;
  }

  for (const album of albums) {
    console.log('\n========================================');
    console.log(`Album: ${album.title} (ID: ${album.album_id})`);
    console.log(`- total_tracks (field): ${album.total_tracks}`);
    console.log(`- duration (field): ${album.duration}`);
    console.log(`- is_published: ${album.is_published}`);
    console.log(`- language_code: ${album.language_code}`);

    // Query tracks linked to this album
    const { data: tracks, error: trackErr } = await supabaseAdmin
      .from('tracks')
      .select('track_id, title, is_published, duration')
      .eq('album_id', album.album_id);

    if (trackErr) {
      console.error(`Error fetching tracks for album ${album.title}:`, trackErr);
    } else {
      console.log(`Actual linked tracks count: ${tracks.length}`);
      tracks.forEach((t) => {
        console.log(`  * Track: "${t.title}" (ID: ${t.track_id}, is_published: ${t.is_published}, duration: ${t.duration})`);
      });
    }
  }
}

run().catch(console.error);
