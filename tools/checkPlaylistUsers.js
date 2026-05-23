require('dotenv').config();
const { supabaseAdmin } = require('../src/db/config');

async function check() {
  console.log('Checking database table structure for playlist collaboration...');

  // 1. Check if is_collaborative column exists on playlists table
  try {
    const { data: colData, error: colError } = await supabaseAdmin
      .from('playlists')
      .select('is_collaborative')
      .limit(1);

    if (colError) {
      if (colError.message.includes('column') || colError.message.includes('does not exist')) {
        console.log('❌ "is_collaborative" column does NOT exist in the "playlists" table.');
      } else {
        console.error('Error checking column:', colError.message);
      }
    } else {
      console.log('✅ "is_collaborative" column exists in the "playlists" table!');
    }
  } catch (err) {
    console.error('Failed checking column:', err.message);
  }

  // 2. Check if playlist_users table exists
  try {
    const { data: tblData, error: tblError } = await supabaseAdmin
      .from('playlist_users')
      .select('*')
      .limit(1);

    if (tblError) {
      if (tblError.message.includes('relation') || tblError.message.includes('does not exist')) {
        console.log('❌ "playlist_users" table does NOT exist in the database.');
      } else {
        console.error('Error checking table:', tblError.message);
      }
    } else {
      console.log('✅ "playlist_users" table exists in the database!');
    }
  } catch (err) {
    console.error('Failed checking table:', err.message);
  }
}

check();
