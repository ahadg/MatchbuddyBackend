import cors from 'cors';
import express from 'express';

import { config } from './config.js';
import { optionalAuth } from './middleware/auth.js';
import fansRouter from './routes/fans.js';
import fixturesRouter from './routes/fixtures.js';
import listingsRouter from './routes/listings.js';
import profileRouter from './routes/profile.js';

const app = express();

app.use(
  cors({
    origin: config.clientOrigin === '*' ? true : config.clientOrigin.split(',').map((item) => item.trim()),
  }),
);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'matchbuddy-backend',
    time: new Date().toISOString(),
  });
});

app.use(optionalAuth);

app.use('/api/fixtures', fixturesRouter);
app.use('/api/fans', fansRouter);
app.use('/api/listings', listingsRouter);
app.use('/api/profile', profileRouter);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    error: error instanceof Error ? error.message : 'Internal server error.',
  });
});

app.listen(config.port, () => {
  console.log(`MatchBuddy backend listening on http://127.0.0.1:${config.port}`);
});
