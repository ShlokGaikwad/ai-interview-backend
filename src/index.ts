import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { connectDB } from '@ai-interview/db';
import { killAllAgents } from './agent-manager';
import interviewsRouter from './routes/interviews';
import joinRouter from './routes/join';
import authRouter from './routes/auth';
import settingsRouter from './routes/settings';
import { authenticate } from './middleware/authenticate';

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use('/auth', authRouter);
app.use('/interviews', authenticate, interviewsRouter);
app.use('/settings', authenticate, settingsRouter);
app.use('/join', joinRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`API server running on port ${PORT}`));

connectDB().catch((err: Error) => {
  console.warn(`[DB] MongoDB unavailable — DB-dependent routes will fail: ${err.message}`);
});

process.on('SIGINT', () => { killAllAgents(); process.exit(0); });
process.on('SIGTERM', () => { killAllAgents(); process.exit(0); });
