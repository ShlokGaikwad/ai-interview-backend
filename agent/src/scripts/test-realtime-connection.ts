import 'dotenv/config';
import { RealtimeSession } from '../pipeline/realtime';

/**
 * Standalone Step 3 check — proves we can open the OpenAI Realtime WebSocket,
 * push the session config, and get it accepted. No LiveKit / no DB needed.
 *
 *   npm run test:realtime
 */
async function main(): Promise<void> {
  console.log('=== OpenAI Realtime connection test ===');
  console.log('Model:', process.env.REALTIME_MODEL ?? 'gpt-realtime-mini');
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY is missing from .env');
    process.exit(1);
  }

  const session = new RealtimeSession({
    instructions:
      'You are Ayush, a friendly product manager conducting a screening interview. Keep replies short and warm.',
  });

  session.on('server-error', (err) => {
    console.error('⚠️  Server rejected part of the config:', err);
  });

  try {
    await session.connect();
    console.log('\n✅ SUCCESS — WebSocket connected and session configured.');
    console.log('The Realtime pipeline can reach OpenAI. Closing in 2s…');
    setTimeout(() => {
      session.close();
      process.exit(0);
    }, 2000);
  } catch (err) {
    console.error('\n❌ FAILED:', (err as Error).message);
    session.close();
    process.exit(1);
  }
}

void main();
