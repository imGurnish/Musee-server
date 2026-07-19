require('dotenv').config();
require('express-async-errors');
const logger = require('./utils/logger');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const createError = require('http-errors');

const { supabase } = require('./db/config');
const { getRedisClient } = require('./utils/redisClient');

const app = express();

// Security & utils
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
    morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
        stream: {
            write: (message) => logger.info(message.trim()),
        },
    })
);

// Basic rate limit
app.use(
    rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 1000,
        standardHeaders: true,
        legacyHeaders: false,
    })
);
// Healthcheck using Supabase JS client
async function supabaseHealth() {
    try {
        // Try a lightweight query on any small table (e.g., 'tracks')
        const { data, error } = await supabase.from('tracks').select('track_id').limit(1);
        if (error) {
            console.error('Supabase health check failed:', error.message);
            return false;
        }
        return true;
    } catch (err) {
        console.error('Supabase health check error:', err.message);
        return false;
    }
}

// Express route
app.get(['/health', '/healthz'], async (req, res) => {
    const dbOk = await supabaseHealth();
    res.status(dbOk ? 200 : 500).json({
        status: dbOk ? 'ok' : 'error',
        env: process.env.NODE_ENV || 'development',
        db: dbOk ? 'ok' : 'error',
    });
});


// API routers (wire up when implemented)
try {
    const adminRoutes = require('./routes/adminRoutes');
    app.use('/api/admin', adminRoutes);
} catch (e) {
    console.warn('Admin routes not mounted:', e?.message || e);
}

try {
    const userRoutes = require('./routes/userRoutes');
    if (typeof userRoutes === 'function' || userRoutes?.stack) {
        app.use('/api/user', userRoutes);
    } else {
        console.warn('User routes not mounted: export is not a router');
    }
} catch (e) {
    console.warn('User routes not mounted:', e?.message || e);
}

try {
    const listeningRoutes = require('./routes/listeningHistoryRoutes');
    if (typeof listeningRoutes === 'function' || listeningRoutes?.stack) {
        app.use('/api', listeningRoutes);
        console.log('Listening routes mounted at /api');
    } else {
        console.warn('Listening routes not mounted: export is not a router');
    }
} catch (e) {
    console.warn('Listening routes not mounted:', e?.message || e);
}

try {
    const publicPlaylistRoutes = require('./routes/publicPlaylistRoutes');
    if (typeof publicPlaylistRoutes === 'function' || publicPlaylistRoutes?.stack) {
        app.use('/api', publicPlaylistRoutes);
        console.log('Public playlist routes mounted at /api');
    } else {
        console.warn('Public playlist routes not mounted: export is not a router');
    }
} catch (e) {
    console.warn('Public playlist routes not mounted:', e?.message || e);
}

// Hard fallback bindings for critical listening endpoints.
// These guarantee route availability even if modular router mount is skipped.
try {
    const authUser = require('./middleware/authUser');
    const listeningController = require('./controllers/listeningHistoryController');
    app.post('/api/listening/log-play', authUser, listeningController.logTrackPlay);
    app.get('/api/recommendations', authUser, listeningController.getRecommendations);
    app.get('/api/listening/recommendations', authUser, listeningController.getRecommendations);
    console.log('Listening fallback routes mounted');
} catch (e) {
    console.warn('Listening fallback routes not mounted:', e?.message || e);
}

// 404 handler
app.use((req, res, next) => {
    next(createError(404, 'Not Found'));
});

// Error handler
app.use((err, req, res, next) => {
    let status = err.status || 500;
    const code = err.code || err?.cause?.code;

    if (!err.status) {
        if (code === '22P02') status = 400;
        else if (code === '23505') status = 409;
        else if (code === '23503') status = 409;
        else if (code === 'PGRST116') status = 404;
        else if (/required|invalid|must be|cannot be|format is invalid|forbidden|unauthorized/i.test(err.message || '')) status = 400;
    }

    const message = err.message || 'Internal Server Error';
    if (process.env.NODE_ENV !== 'production') {
        console.error(err);
    }
    res.status(status).json({ error: message });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Musee API listening on port ${PORT}`);
});

const redisClient = getRedisClient();
redisClient
    .then(() => {
        console.log('Redis client connected');
    })
    .catch((err) => {
        console.error('Redis client connection error:', err);
    });

// Background recommendation jobs (affinity refresh, similarity graph, cache cleanup).
try {
    const { startScheduler } = require('./jobs/scheduler');
    startScheduler();
} catch (e) {
    console.warn('Scheduler not started:', e?.message || e);
}

// Database reconciliation: auto-fail any orphaned queued/processing import jobs upon server boot.
async function reconcileImportJobs() {
    try {
        const { supabaseAdmin } = require('./db/config');
        if (supabaseAdmin) {
            const { data: activeJobs, error: fetchError } = await supabaseAdmin
                .from('import_jobs')
                .select('job_id')
                .in('status', ['queued', 'processing']);
            
            if (fetchError) {
                console.error('[Startup] Failed to fetch active import jobs for reconciliation:', fetchError.message);
                return;
            }

            if (activeJobs && activeJobs.length > 0) {
                const jobIds = activeJobs.map(j => j.job_id);
                console.log(`[Startup] Found ${jobIds.length} orphaned import jobs. Marking them as failed.`);
                
                await supabaseAdmin
                    .from('import_jobs')
                    .update({
                        status: 'failed',
                        error: 'Server restarted during import execution.',
                        finished_at: new Date().toISOString(),
                        progress: 100
                    })
                    .in('job_id', jobIds);

                await supabaseAdmin
                    .from('import_job_tracks')
                    .update({
                        status: 'failed',
                        error: 'Server restarted during import execution.',
                        updated_at: new Date().toISOString()
                    })
                    .in('job_id', jobIds)
                    .in('status', ['queued', 'transcoding', 'downloading']);
            }
        }
    } catch (err) {
        console.error('[Startup] Error during import jobs reconciliation:', err.message);
    }
}
reconcileImportJobs();

module.exports = app;

