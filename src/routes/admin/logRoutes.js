const express = require('express');
const router = express.Router();
const { logEmitter, getRecentLogs } = require('../../utils/logger');

// GET /api/admin/logs/stream
router.get('/stream', (req, res) => {
    // Set headers to establish Server-Sent Events stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Prevent proxy buffering (e.g. Nginx)
    
    // Flush headers to establish connection immediately
    res.flushHeaders();

    // 1. Immediately send historical logs from the in-memory circular buffer
    const history = getRecentLogs();
    for (const log of history) {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    }

    // 2. Setup a ping interval to keep the HTTP connection alive
    const pingInterval = setInterval(() => {
        res.write(': ping\n\n');
    }, 25000);

    // 3. Define callback to handle real-time log emissions
    const onLog = (logEntry) => {
        res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
    };

    // 4. Register listener on our central log emitter
    logEmitter.on('log', onLog);

    // 5. Clean up listeners and intervals on connection termination
    req.on('close', () => {
        clearInterval(pingInterval);
        logEmitter.off('log', onLog);
        res.end();
    });
});

module.exports = router;
