import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';

import { config } from './config.js';
import { attachRealtimeServer } from './lib/realtime.js';
import { optionalAuth } from './middleware/auth.js';
import authRouter from './routes/auth.js';
import chatsRouter from './routes/chats.js';
import fansRouter from './routes/fans.js';
import fixturesRouter from './routes/fixtures.js';
import listingsRouter from './routes/listings.js';
import notificationsRouter from './routes/notifications.js';
import profileRouter from './routes/profile.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

function normalizeOrigin(value) {
  return value.trim().replace(/\/+$/, '');
}

function isAllowedOrigin(origin) {
  if (!origin || config.allowAnyClientOrigin) {
    return true;
  }

  return config.clientOrigins.includes(normalizeOrigin(origin));
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin ${origin} is not allowed by CORS.`));
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Accept', 'Authorization', 'Content-Type'],
  optionsSuccessStatus: 204,
  maxAge: 86400,
};

app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');

  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '8mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'matchbuddy-backend',
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', authRouter);
app.use(optionalAuth);

app.use('/api/fixtures', fixturesRouter);
app.use('/api/fans', fansRouter);
app.use('/api/chats', chatsRouter);
app.use('/api/listings', listingsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/profile', profileRouter);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    error: error instanceof Error ? error.message : 'Internal server error.',
  });
});

const server = createServer(app);

attachRealtimeServer(server);

server.listen(config.port, () => {
  console.log(`MatchBuddy backend listening on http://127.0.0.1:${config.port}`);
});
