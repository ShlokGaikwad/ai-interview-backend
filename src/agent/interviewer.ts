import {
  Room,
  RoomEvent,
  RemoteTrack,
  RemoteParticipant,
  AudioSource,
  LocalAudioTrack,
  AudioFrame,
  TrackKind,
  AudioStream,
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { createDeepgramStream } from './pipeline/stt';
import { getNextResponse, Message } from './pipeline/llm';
import { synthesizeSpeech } from './pipeline/tts';
import { isHoldRequest } from './turn-taking';
import { connectDB, Interview, Transcript, InterviewStatus, Speaker, Settings } from '@ai-interview/db';
import { buildSystemPrompt, DEFAULT_VOICE_INSTRUCTIONS } from './case-studies/selector';

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const SAMPLES_PER_CHANNEL = 480; // 30 ms per frame at 16 kHz

const FAREWELL_PHRASES = [
  'next steps will follow by email',
  'someone from the team will follow up',
  'we\'ll be in touch',
  'we will be in touch',
  'thank you for your time',
  'thanks for your time',
  'that\'s all i needed',
  'that is all i needed',
  'i have what i need',
  'i\'ve got what i need',
  'good luck',
  'best of luck',
  'goodbye',
  'good bye',
  'take care',
];

function isFarewell(text: string): boolean {
  const lower = text.toLowerCase();
  return FAREWELL_PHRASES.some((phrase) => lower.includes(phrase));
}

// Words that indicate a sentence is mid-thought — speechFinal should be ignored if transcript ends with these
const INCOMPLETE_TRAILING = new Set([
  'from', 'with', 'at', 'to', 'in', 'on', 'of', 'for', 'by', 'about', 'into',
  'through', 'and', 'but', 'or', 'so', 'yet', 'because', 'although', 'since',
  'while', 'if', 'unless', 'until', 'as', 'a', 'an', 'the', 'my', 'our',
  'their', 'its', 'i', 'am', 'is', 'are', 'was', 'were', 'that', 'which',
]);

function looksIncomplete(text: string): boolean {
  const lastWord = text.trim().split(/\s+/).pop()?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  return INCOMPLETE_TRAILING.has(lastWord);
}


function pcmToFrames(pcm: Buffer): AudioFrame[] {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  const frames: AudioFrame[] = [];

  for (let i = 0; i < samples.length; i += SAMPLES_PER_CHANNEL) {
    const slice = samples.slice(i, i + SAMPLES_PER_CHANNEL);
    let data = slice;
    if (slice.length < SAMPLES_PER_CHANNEL) {
      data = new Int16Array(SAMPLES_PER_CHANNEL);
      data.set(slice);
    }
    frames.push(new AudioFrame(data, SAMPLE_RATE, NUM_CHANNELS, SAMPLES_PER_CHANNEL));
  }

  return frames;
}

export async function startInterviewer(roomName: string): Promise<void> {
  // Connect to MongoDB — non-fatal if unavailable, turns just won't be saved
  try {
    await connectDB();
    // Seed default prompt into Settings if no document exists yet
    const existing = await Settings.findOne().lean();
    if (!existing) {
      await Settings.create({ voiceInstructions: DEFAULT_VOICE_INSTRUCTIONS, changeHistory: [] });
      console.log('[Agent] Seeded default voice instructions into Settings');
    }
  } catch (err) {
    console.warn('[DB] MongoDB unavailable — transcripts will not be saved:', (err as Error).message);
  }

  const interviewId = process.env.INTERVIEW_ID;
  if (!interviewId) throw new Error('[Agent] INTERVIEW_ID env var is required — agent must be spawned by the backend');

  const interviewDoc = await Interview.findById(interviewId).catch(() => null);
  if (!interviewDoc) throw new Error(`[Agent] Interview not found: ${interviewId}`);

  // Resolve system prompt from assigned case study — required, agent exits if missing
  const caseStudyId = interviewDoc?.caseStudyIds?.[0];
  if (!caseStudyId) throw new Error('[Agent] No case study assigned to this interview — cannot start');
  const systemPrompt = await buildSystemPrompt(caseStudyId);
  console.log(`[Agent] Using case study: ${caseStudyId}`);

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
    { identity: 'ai-interviewer', name: 'AI Interviewer' },
  );
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  const token = await at.toJwt();

  const room = new Room();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await room.connect(process.env.LIVEKIT_URL!, token, { autoSubscribe: true } as any);
  console.log(`[Agent] Connected to room: ${roomName}`);

  const audioSource = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
  const localTrack = LocalAudioTrack.createAudioTrack('interviewer-audio', audioSource);
  if (!room.localParticipant) throw new Error('No local participant after connect');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await room.localParticipant.publishTrack(localTrack, { source: 2 } as any);
  console.log('[Agent] Audio track published');

  // Session recovery: reload history from saved turns if this interview has prior turns
  type AgentState = 'waiting' | 'listening' | 'processing' | 'speaking';
  let state: AgentState = 'processing';
  const history: Message[] = [];
  let accumulatedTranscript = '';
  let greeted = false;
  let speakCancelled = false;
  let turnTimer: ReturnType<typeof setTimeout> | null = null;
  const TURN_DEBOUNCE_MS = 1800;
  let turnCount = 0;
  let isRecovery = false;

  // Silence detection: nudge candidate if they don't respond after AI finishes speaking
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceNudgeCount = 0;
  const SILENCE_FIRST_NUDGE_MS = 12000;  // 12s → short prompt
  const SILENCE_REPEAT_MS = 30000;       // 30s → LLM repeats question

  function clearSilenceTimer() {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }

  async function nudgeCandidate() {
    if (state !== 'listening') return;
    silenceNudgeCount++;

    if (silenceNudgeCount === 1) {
      const nudge = "Take your time — I'm still here whenever you're ready.";
      await saveTurn(Speaker.AI, nudge);
      await speak(nudge);
    } else {
      // Ask LLM to gently rephrase the last question — don't pollute history with the trigger
      try {
        const tempHistory: Message[] = [
          ...history,
          { role: 'user', content: '[The candidate has still not responded. Gently rephrase your last question in 1 to 2 sentences.]' },
        ];
        const nudge = await getNextResponse(systemPrompt, tempHistory);
        history.push({ role: 'assistant', content: nudge });
        await saveTurn(Speaker.AI, nudge);
        await speak(nudge);
      } catch {
        // fallback if LLM fails
        const fallback = "Just checking in — feel free to respond whenever you're ready.";
        await saveTurn(Speaker.AI, fallback);
        await speak(fallback);
      }
    }
  }

  function startSilenceTimer() {
    clearSilenceTimer();
    const delay = silenceNudgeCount === 0 ? SILENCE_FIRST_NUDGE_MS : SILENCE_REPEAT_MS;
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      void nudgeCandidate();
    }, delay);
  }

  if (interviewDoc) {
    try {
      const existing = await Transcript.findOne({ interviewId: interviewDoc._id });
      if (existing && existing.turns.length > 0) {
        for (const t of existing.turns) {
          history.push({ role: t.speaker === Speaker.AI ? 'assistant' : 'user', content: t.text });
        }
        turnCount = existing.turns[existing.turns.length - 1].turn;
        isRecovery = true;
        console.log(`[Agent] Recovered ${existing.turns.length} turns from MongoDB`);
      }
    } catch (err) {
      console.warn('[Agent] Could not load existing transcript:', (err as Error).message);
    }
  }

  async function saveTurn(speaker: Speaker, text: string): Promise<void> {
    if (!interviewDoc) return;
    try {
      turnCount++;
      await Transcript.findOneAndUpdate(
        { interviewId: interviewDoc._id },
        { $push: { turns: { turn: turnCount, speaker, text, timestamp: new Date() } } },
        { upsert: true },
      );
    } catch (err) {
      console.error('[DB] Failed to save turn:', err);
    }
  }

  let interruptBuffer = ''; // isFinal segments captured while AI was speaking
  let lastFinalText = '';  // guards against Deepgram sending the same segment twice (isFinal then speechFinal)

  async function speak(text: string): Promise<void> {
    clearSilenceTimer();
    interruptBuffer = '';
    state = 'speaking';
    speakCancelled = false;
    console.log(`[Agent] Speaking: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`);
    try {
      const pcm = await synthesizeSpeech(text);
      for (const frame of pcmToFrames(pcm)) {
        if (speakCancelled) {
          console.log('[Agent] Interrupted by candidate');
          break;
        }
        await audioSource.captureFrame(frame);
      }
    } catch (err) {
      console.error('[Agent] TTS error:', err);
    } finally {
      if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }

      // If candidate disconnected mid-speech, the disconnect handler already set
      // state = 'waiting'. Don't overwrite it or start any timers.
      if ((state as AgentState) === 'waiting') return;

      state = 'listening';

      if (interruptBuffer) {
        // Candidate spoke while AI was talking — seed accumulated transcript and
        // start a short debounce in case they're still speaking
        accumulatedTranscript = interruptBuffer;
        interruptBuffer = '';
        turnTimer = setTimeout(async () => {
          turnTimer = null;
          if (!accumulatedTranscript || state !== 'listening') return;
          const turn = accumulatedTranscript;
          accumulatedTranscript = '';
          lastFinalText = '';
          console.log(`[Candidate - interrupt resolved] "${turn}"`);
          await handleTurn(turn);
        }, TURN_DEBOUNCE_MS);
      } else {
        accumulatedTranscript = '';
        startSilenceTimer();
      }
    }
  }

  async function handleTurn(candidateText: string): Promise<void> {
    const t0 = Date.now();
    silenceNudgeCount = 0;
    clearSilenceTimer();
    await saveTurn(Speaker.CANDIDATE, candidateText);

    if (isHoldRequest(candidateText)) {
      const holdReply = 'Of course, take your time.';
      await saveTurn(Speaker.AI, holdReply);
      await speak(holdReply);
      return;
    }

    state = 'processing';
    history.push({ role: 'user', content: candidateText });

    try {
      const t1 = Date.now();
      const response = await getNextResponse(systemPrompt, history);
      const t2 = Date.now();
      console.log(`[Timing] LLM: ${t2 - t1}ms | total to response: ${t2 - t0}ms`);

      history.push({ role: 'assistant', content: response });
      await saveTurn(Speaker.AI, response);

      const t3 = Date.now();
      await speak(response);
      const t4 = Date.now();
      console.log(`[Timing] TTS+playback: ${t4 - t3}ms`);

      if (isFarewell(response)) {
        console.log('[Agent] Farewell detected — ending interview in 3s');
        clearSilenceTimer();
        if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
        // Mark completed now so candidate cannot rejoin before agent disconnects
        if (interviewDoc) {
          await Interview.updateOne(
            { _id: interviewDoc._id },
            { status: InterviewStatus.COMPLETED, endedAt: new Date() },
          ).catch(() => null);
        }
        setTimeout(() => room.disconnect(), 3000);
      }
    } catch (err) {
      console.error('[Agent] LLM error:', err);
      state = 'listening';
    }
  }

  // Subscribe to candidate audio and run cascade
  room.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteTrack, _pub: unknown, participant: RemoteParticipant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      console.log(`[Agent] Subscribed to audio from: ${participant.identity}`);

      const dg = createDeepgramStream(
        async (segment) => {
          // While AI is speaking: accumulate isFinal segments so they aren't lost.
          // Interrupt threshold is higher in early turns (greeting + company overview) so the
          // candidate continuing their intro doesn't immediately cancel the AI.
          // After turn 4 the interview is in question mode — drop back to normal threshold.
          if (state === 'speaking') {
            if (segment.isFinal && segment.text) {
              interruptBuffer = (interruptBuffer + ' ' + segment.text).trim();
              const interruptThreshold = turnCount < 4 ? 12 : 6;
              if (interruptBuffer.split(/\s+/).length >= interruptThreshold) {
                speakCancelled = true;
              }
            }
            return;
          }

          if (state !== 'listening') return;

          // Live interim display — clears silence timer and resets turn timer while
          // candidate is actively speaking (interim results prove they haven't stopped yet)
          if (segment.text) {
            clearSilenceTimer();
            if (!segment.isFinal && turnTimer) {
              clearTimeout(turnTimer);
              turnTimer = null;
            }
            const preview = (accumulatedTranscript + ' ' + segment.text).trim();
            process.stdout.write(`\r[Candidate] ${preview}   `);
          }

          if (segment.isFinal && segment.text && segment.text !== lastFinalText) {
            accumulatedTranscript = (accumulatedTranscript + ' ' + segment.text).trim();
            lastFinalText = segment.text;
          }

          // speechFinal means Deepgram's VAD detected end of speech — but the candidate
          // may just be pausing between sentences. Never fire immediately; always wait a
          // buffer so they can continue. Delay varies by turn phase and completeness:
          //   - Early turns (intro phase, turnCount < 4): 2500ms — candidates speak in
          //     multiple short sentences with natural breathing gaps between them
          //   - Later turns (question phase): 2000ms — answers are more self-contained
          //   - Short or trailing incomplete word: 3600ms — almost certainly continuing
          if (segment.speechFinal && accumulatedTranscript) {
            const wordCount = accumulatedTranscript.trim().split(/\s+/).length;
            const incomplete = looksIncomplete(accumulatedTranscript);
            const completeDelay = turnCount < 4 ? 2500 : 2000;
            const delay = wordCount >= 3 && !incomplete ? completeDelay : TURN_DEBOUNCE_MS * 2;
            const speechFinalAt = Date.now();

            if (turnTimer) clearTimeout(turnTimer);
            turnTimer = setTimeout(async () => {
              turnTimer = null;
              if (!accumulatedTranscript || state !== 'listening') return;
              const turn = accumulatedTranscript;
              accumulatedTranscript = '';
              lastFinalText = '';
              process.stdout.write('\n');
              console.log(`[Timing] Debounce wait: ${Date.now() - speechFinalAt}ms (planned: ${delay}ms)`);
              console.log(`[Candidate - final] "${turn}"`);
              await handleTurn(turn);
            }, delay);
            return;
          }

          if (segment.isFinal && segment.text) {
            // Fallback debounce in case speechFinal never fires
            const isFinalAt = Date.now();
            if (turnTimer) clearTimeout(turnTimer);
            turnTimer = setTimeout(async () => {
              turnTimer = null;
              if (!accumulatedTranscript || state !== 'listening') return;
              const turn = accumulatedTranscript;
              accumulatedTranscript = '';
              lastFinalText = '';
              process.stdout.write('\n');
              console.log(`[Timing] Debounce wait (fallback): ${Date.now() - isFinalAt}ms (planned: ${TURN_DEBOUNCE_MS}ms)`);
              console.log(`[Candidate - final (debounce)] "${turn}"`);
              await handleTurn(turn);
            }, TURN_DEBOUNCE_MS);
          }
        },
        (err) => console.error('[Agent] STT error:', err),
      );

      const audioStream = new AudioStream(track, SAMPLE_RATE, NUM_CHANNELS);
      void (async () => {
        for await (const frame of audioStream) {
          // Always forward audio — keeps Deepgram alive during agent speech.
          // Transcript handler ignores results when state !== 'listening'.
          dg.sendAudio(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
        }
        dg.close();
      })();
    },
  );

  async function greetCandidate(identity: string): Promise<void> {
    if (greeted) {
      // Candidate reconnected after a drop — run recovery
      console.log(`[Agent] Candidate reconnected: ${identity}`);
      await new Promise((r) => setTimeout(r, 1500));
      state = 'processing';
      try {
        const tempHistory: Message[] = [
          ...history,
          {
            role: 'user',
            content: '[You got disconnected and the person just rejoined. Acknowledge the drop briefly and naturally — like a real person would on a call ("Oh looks like we got cut off"). Then in one sentence remind them what you were just talking about and continue from there. Keep it casual, max 2 sentences.]',
          },
        ];
        const resumeMsg = await getNextResponse(systemPrompt, tempHistory);
        history.push({ role: 'assistant', content: resumeMsg });
        await saveTurn(Speaker.AI, resumeMsg);
        await speak(resumeMsg);
      } catch (err) {
        console.error('[Agent] Reconnect recovery failed:', err);
        const fallback = "Oh looks like we got cut off — no worries. Where were we?";
        await saveTurn(Speaker.AI, fallback);
        await speak(fallback);
      }
      return;
    }

    greeted = true;
    console.log(`[Agent] Greeting candidate: ${identity}`);

    // Mark interview as active
    if (interviewDoc) {
      await Interview.updateOne(
        { _id: interviewDoc._id },
        { status: InterviewStatus.ACTIVE, startedAt: new Date() },
      ).catch(() => null);
    }

    // Give TrackSubscribed and Deepgram connection time to open
    await new Promise((r) => setTimeout(r, 1500));

    if (isRecovery) {
      // Candidate reconnected after a drop — resume naturally without sounding robotic
      try {
        const tempHistory: Message[] = [
          ...history,
          {
            role: 'user',
            content: '[You got disconnected and the person just rejoined. Acknowledge the drop briefly and naturally — like a real person would on a call ("Oh looks like we got cut off"). Then in one sentence remind them what you were just talking about and continue from there. Keep it casual, max 2 sentences.]',
          },
        ];
        const resumeMsg = await getNextResponse(systemPrompt, tempHistory);
        history.push({ role: 'assistant', content: resumeMsg });
        await saveTurn(Speaker.AI, resumeMsg);
        await speak(resumeMsg);
      } catch (err) {
        console.error('[Agent] Recovery LLM call failed:', err);
        const fallback = "Oh looks like we got cut off — no worries. Where were we?";
        await saveTurn(Speaker.AI, fallback);
        await speak(fallback);
      }
    } else {
      // Seed history with a silent trigger so the LLM follows the system prompt's opening instruction
      history.push({ role: 'user', content: '[interview started]' });
      try {
        const opening = await getNextResponse(systemPrompt, history);
        history.push({ role: 'assistant', content: opening });
        await saveTurn(Speaker.AI, opening);
        await speak(opening);
      } catch (err) {
        console.error('[Agent] Opening LLM call failed:', err);
      }
    }
  }

  // Stop everything when candidate disconnects — don't speak to an empty room
  room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    if (participant.identity.startsWith('observer-')) return;
    console.log(`[Agent] Candidate disconnected: ${participant.identity} — pausing`);
    speakCancelled = true;
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
    clearSilenceTimer();
    accumulatedTranscript = '';
    interruptBuffer = '';
    state = 'waiting';
  });

  // Greet participant who joins after the agent — ignore silent observers
  room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    if (participant.identity.startsWith('observer-')) {
      console.log(`[Agent] Observer joined — skipping greeting: ${participant.identity}`);
      return;
    }
    void greetCandidate(participant.identity);
  });

  // Safety net: greet candidate already in room (e.g. joined before agent finished starting)
  const existing = [...room.remoteParticipants.values()].filter(
    (p) => !p.identity.startsWith('observer-'),
  );
  if (existing.length > 0) {
    console.log('[Agent] Candidate already in room — greeting immediately');
    void greetCandidate(existing[0].identity);
  }

  room.on(RoomEvent.Disconnected, () => {
    console.log('[Agent] Room disconnected');
    clearSilenceTimer();
    if (interviewDoc) {
      Interview.updateOne(
        { _id: interviewDoc._id },
        { status: InterviewStatus.COMPLETED, endedAt: new Date() },
      ).catch(() => null);
    }
  });

  console.log('[Agent] Waiting for candidate...');
  await new Promise<void>((resolve) => {
    room.on(RoomEvent.Disconnected, () => resolve());
  });
}
