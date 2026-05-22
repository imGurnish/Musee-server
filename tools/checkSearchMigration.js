require('dotenv').config();
const { supabaseAdmin } = require('../src/db/config');
const fs = require('fs');
const path = require('path');

async function run() {
  console.log('Checking if fuzzy trigram search database functions exist on Supabase...');

  try {
    // Attempt a test call to search_track_ids with a dummy search term
    const { data, error } = await supabaseAdmin.rpc('search_track_ids', {
      search_term: 'test',
      preferred_languages: [],
      limit_val: 1,
      offset_val: 0
    });

    if (error) {
      if (error.code === '42883' || error.code === 'PGRST202' || error.message.includes('does not exist') || error.message.includes('Could not find the function')) {
        console.log('\n❌ Fuzzy search functions do NOT exist in the database yet.');
        console.log('\n========================================================================');
        console.log('👉 ACTION REQUIRED:');
        console.log('Please copy the contents of the following SQL migration file:');
        console.log('   docs/migrations/005_fuzzy_trigram_search.sql');
        console.log('\nAnd run it in your Supabase Dashboard SQL Editor at:');
        console.log(`   https://supabase.com/dashboard/project/${extractProjectRef()}/sql/new`);
        console.log('========================================================================\n');
      } else {
        console.error('Unexpected database error:', error);
      }
    } else {
      console.log('✅ Success! Fuzzy search database functions are installed and working.');
      console.log('Test results:', data);
    }
  } catch (err) {
    console.error('Failed to connect to database check:', err.message || err);
  }
}

function extractProjectRef() {
  const url = process.env.SUPABASE_URL || '';
  const match = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  return match ? match[1] : 'your-project-ref';
}

run();
