'use strict';

const path    = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const morgan     = require('morgan');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase }                  = require('firebase-admin/database');

// Format private key properly for Vercel / environment variables
const formatPrivateKey = (key) => {
  if (!key) return '';
  let formatted = key.trim();
  if (formatted.startsWith('"') && formatted.endsWith('"')) {
    formatted = formatted.slice(1, -1);
  }
  return formatted.replace(/\\n/g, '\n');
};

// Build service account from environment variables (no JSON file needed)
const serviceAccount = {
  type:                        process.env.FIREBASE_TYPE            || 'service_account',
  project_id:                  process.env.FIREBASE_PROJECT_ID,
  private_key_id:              process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key:                 formatPrivateKey(process.env.FIREBASE_PRIVATE_KEY),
  client_email:                process.env.FIREBASE_CLIENT_EMAIL,
  client_id:                   process.env.FIREBASE_CLIENT_ID,
  auth_uri:                    process.env.FIREBASE_AUTH_URI         || 'https://accounts.google.com/o/oauth2/auth',
  token_uri:                   process.env.FIREBASE_TOKEN_URI        || 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL || 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url:        process.env.FIREBASE_CLIENT_CERT_URL,
  universe_domain:             process.env.FIREBASE_UNIVERSE_DOMAIN  || 'googleapis.com',
};

if (!getApps().length) {
  initializeApp({
    credential:  cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

const db = getDatabase();
module.exports.db = db;

const app = express();
app.db = db;

app.use(cors({ origin: '*' }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));

app.use(express.static(path.join(__dirname, '../website')));

const logsRoutes        = require('./routes/logs');
const systemRoutes      = require('./routes/system');
const facesRoutes       = require('./routes/faces');

app.use('/api/logs',        logsRoutes);
app.use('/api/system',      systemRoutes);
app.use('/api/faces',       facesRoutes);

// ── SSE: Real-time Event Stream ───────────────────────────────
/**
 * GET /api/events
 * Server-Sent Events endpoint. Streams real-time Firebase updates
 * to any connected browser/client.
 *
 * Events emitted:
 *   - type: 'system'     → system node snapshot
 *   - type: 'access_logs' → last 5 access log entries
 */
app.get('/api/events', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Helper to send an SSE message
  const sendEvent = (type, data) => {
    try {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    } catch (_) {
    }
  };

  sendEvent('connected', { message: 'SSE connection established', timestamp: Date.now() });

  const systemRef = db.ref('system');
  const systemListener = systemRef.on(
    'value',
    (snapshot) => {
      sendEvent('system', snapshot.val() || {});
    },
    (err) => {
      console.error('[SSE] system watch error:', err.message);
    }
  );

  
  const logsRef = db.ref('access_logs').orderByChild('timestamp').limitToLast(5);
  const logsListener = logsRef.on(
    'value',
    (snapshot) => {
      const raw = snapshot.val();
      if (!raw) {
        sendEvent('access_logs', []);
        return;
      }
      
      const logs = Object.entries(raw)
        .map(([id, val]) => ({ id, ...val }))
        .sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));
      sendEvent('access_logs', logs);
    },
    (err) => {
      console.error('[SSE] access_logs watch error:', err.message);
    }
  );

  // ── Keepalive ping every 25 seconds ─────────────────────────
  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      clearInterval(pingInterval);
    }
  }, 25000);

  // ── Cleanup on client disconnect 
  req.on('close', () => {
    clearInterval(pingInterval);
    systemRef.off('value', systemListener);
    logsRef.off('value',   logsListener);
    console.log('[SSE] Client disconnected');
  });
});


app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});


app.use((err, req, res, _next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});


const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Smart Door Lock API Server`);
    console.log(`    Listening at: http://localhost:${PORT}`);
    console.log(`    Firebase project: sistem-pintu-otomatis\n`);
  });
}

module.exports = app;
module.exports.db = db;
