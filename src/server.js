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

app.use(
  cors({
    origin: config.clientOrigin === '*' ? true : config.clientOrigin.split(',').map((item) => item.trim()),
  }),
);
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
