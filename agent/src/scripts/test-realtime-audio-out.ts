import 'dotenv/config';
import fs from 'node:fs';
import { RealtimeSession } from '../pipeline/realtime';

/**
 * Standalone Step 5 check — proves OpenAI → audio out works, and reveals the exact
 * GA event names that carry the audio + transcript.
 *
 * No LiveKit, no ElevenLabs. We trigger the AI to speak by sending a text message
 * (the same '[interview started]' trigger the real greeting uses), then capture the
 * audio deltas OpenAI streams back and write them to a .wav you can play.
 *
 *   npm run test:realtime:audioout
 */

function writeWav(pcm: Buffer, sampleRate: number, path: string): void {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(path, Buffer.concat([header, pcm]));
}

async function main(): Promise<void> {
  console.log('=== OpenAI Realtime audio-out test (Step 5) ===');

  const session = new RealtimeSession({
    instructions:
      'You are Ayush, a friendly product manager. Greet the candidate warmly and introduce yourself in one or two short sentences.',
  });

  const audioChunks: Buffer[] = [];
  let transcript = '';
  let audioEventName = '';
  const seen = new Set<string>();

  session.on('event', (event) => {
    if (!seen.has(event.type)) {
      seen.add(event.type);
      console.log('  ← event:', event.type);
    }

    // The audio delta event carries base64 PCM in `event.delta`, and its type
    // mentions "audio" but NOT "transcript".
    if (typeof event.delta === 'string' && event.type.includes('audio') && !event.type.includes('transcript')) {
      if (!audioEventName) audioEventName = event.type;
      audioChunks.push(Buffer.from(event.delta, 'base64'));
    }

    // The spoken transcript arrives on a *_transcript.delta event.
    if (typeof event.delta === 'string' && event.type.includes('transcript')) {
      transcript += event.delta;
    }

    if (event.type === 'response.done') {
      const pcm = Buffer.concat(audioChunks);
      console.log('\n--- Result ---');
      console.log(`Audio event name : ${audioEventName || '(none seen)'}`);
      console.log(`Audio received   : ${audioChunks.length} chunks, ${pcm.length} bytes (~${(pcm.length / 2 / 24000).toFixed(1)}s)`);
      console.log(`Spoken text      : ${transcript || '(none)'}`);
      if (pcm.length > 0) {
        writeWav(pcm, 24000, 'realtime-greeting.wav');
        console.log('✅ Wrote realtime-greeting.wav — play it to hear Ayush');
      } else {
        console.log('❌ No audio received');
      }
      setTimeout(() => {
        session.close();
        process.exit(pcm.length > 0 ? 0 : 1);
      }, 300);
    }
  });

  await session.connect();
  console.log('Connected. Triggering a spoken greeting via text…');
  session.send({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[interview started]' }] },
  });
  session.send({ type: 'response.create' });
}

void main();
