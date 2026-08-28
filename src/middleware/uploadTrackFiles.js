const os = require('os');
const multer = require('multer');

// disk storage to stream large track/video files to temporary disk rather than RAM
const storage = multer.diskStorage({
    destination: os.tmpdir(),
});
const upload = multer({
    storage,
    limits: { fileSize: 152 * 1024 * 1024 }, // 152MB default for tracks/videos
});

// expect fields: video (file, optional), audio (file, optional)
// note: track covers are no longer accepted; album cover is used instead
module.exports = upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'audio', maxCount: 1 },
]);
