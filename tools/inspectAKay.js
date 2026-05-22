require('dotenv').config();
const { supabaseAdmin } = require('../src/db/config');
const { createClient } = require('@supabase/supabase-js');
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || '');

async function run() {
  console.log('Searching for users/artists matching "kay"...');
  const { data: users, error: userErr } = await supabaseAdmin
    .from('users')
    .select('user_id, name, user_type')
    .ilike('name', '%kay%');

  if (userErr) {
    console.error('Error fetching users:', userErr);
    return;
  }

  console.log('Matches in users table:');
  console.log(users);

  // We need to sign in a dummy user or retrieve a user from auth to get a valid token
  console.log('\nSigning in temporary dummy user...');
  const email = `testsearch_${Date.now()}@example.com`;
  const password = 'Passw0rd!123456';
  
  const created = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  const dummyUserId = created.data.user.id;

  // Insert profile row so database trigger is happy
  await supabaseAdmin.from('users').upsert({
    user_id: dummyUserId,
    email,
    name: 'Search Dummy User',
    user_type: 'listener'
  });

  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  const token = signIn.data.session?.access_token;
  
  console.log('Dummy user signed in, token retrieved.');

  const BASE_URL = 'http://localhost:8080';
  
  for (const query of ['a kay', 'a-kay', 'a_kay']) {
    console.log(`\nQuerying endpoint with q="${query}"...`);
    try {
      const res = await fetch(`${BASE_URL}/api/user/search?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const json = await res.json();
      console.log(`Response Status: ${res.status}`);
      if (res.status !== 200) {
        console.log('Error payload:', json);
      } else {
        console.log(`Result counts for "${query}":`);
        console.log(`- tracks: ${json.tracks?.length}`);
        console.log(`- albums: ${json.albums?.length}`);
        console.log(`- artists: ${json.artists?.length}`);
        if (json.artists?.length > 0) {
          console.log('Matched artists:', json.artists.map(a => ({ name: a.name, id: a.artist_id })));
        }
      }
    } catch (err) {
      console.error('Fetch error:', err.message);
    }
  }

  // Cleanup
  console.log('\nCleaning up dummy user...');
  await supabaseAdmin.auth.admin.deleteUser(dummyUserId);
  await supabaseAdmin.from('users').delete().eq('user_id', dummyUserId);
}

run().catch(console.error);
