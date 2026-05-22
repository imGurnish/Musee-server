require('dotenv').config();
const { supabaseAdmin } = require('../src/db/config');

async function run() {
  const { data: tracks } = await supabaseAdmin.from('tracks').select('title').limit(5);
  const { data: albums } = await supabaseAdmin.from('albums').select('title').limit(5);
  const { data: users } = await supabaseAdmin.from('users').select('name').eq('user_type', 'artist').limit(5);

  console.log('Sample Tracks:', tracks?.map(t => t.title));
  console.log('Sample Albums:', albums?.map(a => a.title));
  console.log('Sample Artists:', users?.map(u => u.name));
}

run();
