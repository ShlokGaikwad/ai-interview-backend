import 'dotenv/config';
import { startInterviewer } from './interviewer';
import { startRealtimeInterviewer } from './interviewer-realtime';

const roomName = process.env.LIVEKIT_ROOM_NAME;

if (!roomName) {
  console.error('LIVEKIT_ROOM_NAME env var is required');
  process.exit(1);
}

const useRealtime = process.env.USE_REALTIME === 'true';

if (useRealtime) {
  console.log(`[Agent] Using Realtime pipeline (${process.env.REALTIME_MODEL ?? 'gpt-realtime-mini'})`);
  startRealtimeInterviewer(roomName).catch((err) => {
    console.error('Realtime agent crashed:', err);
    process.exit(1);
  });
} else {
  console.log('[Agent] Using current pipeline (Deepgram → GPT-4o-mini → ElevenLabs)');
  startInterviewer(roomName).catch((err) => {
    console.error('Agent crashed:', err);
    process.exit(1);
  });
}
