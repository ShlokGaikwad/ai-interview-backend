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
import { connectDB, Interview, Transcript, InterviewStatus, Speaker } from '@ai-interview/db';
import { buildSystemPrompt } from './case-studies/selector';

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const SAMPLES_PER_CHANNEL = 480; // 30 ms per frame at 16 kHz

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
    silenceNudgeCount = 0; // candidate responded — reset nudge cycle
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
      const response = await getNextResponse(systemPrompt, history);
      history.push({ role: 'assistant', content: response });
      await saveTurn(Speaker.AI, response);
      await speak(response);
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

          // Live interim display — also clears silence timer as soon as candidate starts talking
          if (segment.text) {
            clearSilenceTimer();
            const preview = (accumulatedTranscript + ' ' + segment.text).trim();
            process.stdout.write(`\r[Candidate] ${preview}   `);
          }

          if (segment.isFinal && segment.text) {
            accumulatedTranscript = (accumulatedTranscript + ' ' + segment.text).trim();
          }

          // speechFinal means Deepgram's VAD detected end of speech — but the candidate
          // may just be pausing between sentences. Never fire immediately; always wait a
          // short buffer so they can continue. Delay varies by how complete the sentence looks:
          //   - Complete (3+ words, no trailing fragment): 1200ms — likely done, small safety gap
          //   - Short or trailing incomplete word: 3600ms — almost certainly continuing
          if (segment.speechFinal && accumulatedTranscript) {
            const wordCount = accumulatedTranscript.trim().split(/\s+/).length;
            const incomplete = looksIncomplete(accumulatedTranscript);
            const delay = wordCount >= 3 && !incomplete ? 1200 : TURN_DEBOUNCE_MS * 2;

            if (turnTimer) clearTimeout(turnTimer);
            turnTimer = setTimeout(async () => {
              turnTimer = null;
              if (!accumulatedTranscript || state !== 'listening') return;
              const turn = accumulatedTranscript;
              accumulatedTranscript = '';
              process.stdout.write('\n');
              console.log(`[Candidate - final] "${turn}"`);
              await handleTurn(turn);
            }, delay);
            return;
          }

          if (segment.isFinal && segment.text) {
            // Fallback debounce in case speechFinal never fires
            if (turnTimer) clearTimeout(turnTimer);
            turnTimer = setTimeout(async () => {
              turnTimer = null;
              if (!accumulatedTranscript || state !== 'listening') return;
              const turn = accumulatedTranscript;
              accumulatedTranscript = '';
              process.stdout.write('\n');
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
    if (greeted) return;
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
      // History is fully loaded from DB — ask the LLM to generate a contextual recovery
      // message that recaps what it last said and re-asks any pending question.
      // The trigger is not saved to the transcript or persisted in history.
      try {
        const tempHistory: Message[] = [
          ...history,
          {
            role: 'user',
            content: '[The candidate just reconnected after a connection drop. Welcome them back briefly, recap the last thing you said in one sentence, and re-ask any unanswered question. Maximum 3 sentences total.]',
          },
        ];
        const resumeMsg = await getNextResponse(systemPrompt, tempHistory);
        history.push({ role: 'assistant', content: resumeMsg });
        await saveTurn(Speaker.AI, resumeMsg);
        await speak(resumeMsg);
      } catch (err) {
        console.error('[Agent] Recovery LLM call failed:', err);
        const fallback = "Welcome back — it looks like we got disconnected. Let's pick up where we left off.";
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

  // Greet participant who joins after the agent
  room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    void greetCandidate(participant.identity);
  });

  // Safety net: greet candidate already in room (e.g. joined before agent finished starting)
  const existing = [...room.remoteParticipants.values()];
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
