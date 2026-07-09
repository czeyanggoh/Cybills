import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env } from './env.js';
import { authRouter } from './auth.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(morgan('tiny'));

// Health check — nginx proxies /api/* here, and deploy.sh curls this to
// confirm the backend came back up after a restart.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'cybills-server', ts: new Date().toISOString() });
});

// Google sign-in (auth code flow). No-ops until credentials are configured.
app.use('/api/auth', authRouter);

app.listen(env.PORT, () => {
  console.log(`[cybills] server listening on :${env.PORT} (${env.NODE_ENV})`);
});
