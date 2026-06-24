import 'dotenv/config';
import { startInterviewer } from './interviewer';

const roomName = process.env.LIVEKIT_ROOM_NAME;

if (!roomName) {
  console.error('LIVEKIT_ROOM_NAME env var is required');
  process.exit(1);
}

startInterviewer(roomName).catch((err) => {
  console.error('Agent crashed:', err);
  process.exit(1);
});
