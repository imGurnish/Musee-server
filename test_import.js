const dotenv = require('dotenv');
dotenv.config();

const importController = require('./src/controllers/admin/importController');

const req = {
  params: { trackId: 'TyNCNCum' }, // JioSaavn track ID
  user: { id: '6d9379f2-58e7-4345-8a65-402f8c5a61b2' } // User ID from logs
};

const res = {
  status: function(code) {
    console.log('\n[Express res] Status:', code);
    return this;
  },
  json: function(data) {
    console.log('[Express res] JSON:', JSON.stringify(data, null, 2));
    return this;
  }
};

console.log('Triggering local import for track TyNCNCum...');
importController.importTrack(req, res).catch(err => {
  console.error('Import initialization failed:', err);
});
