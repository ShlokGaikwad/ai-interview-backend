import "dotenv/config";
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
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import {
  connectDB,
  Interview,
  Transcript,
  InterviewStatus,
  Speaker,
  Settings,
} from "@ai-interview/db";
import {
  buildSystemPrompt,
  DEFAULT_VOICE_INSTRUCTIONS,
} from "./case-studies/selector";
import { RealtimeSession, RealtimeEvent } from "./pipeline/realtime";

const REALTIME_MODEL = process.env.REALTIME_MODEL;

// OpenAI Realtime API sends/receives PCM16 at 24 kHz
const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const SAMPLES_PER_CHANNEL = 720; // 30 ms × 24 kHz

const FAREWELL_PHRASES = [
  "next steps will follow by email",
  "someone from the team will follow up",
  "we'll be in touch",
  "we will be in touch",
  "thank you for your time",
  "thanks for your time",
  "that's all i needed",
  "that is all i needed",
  "i have what i need",
  "i've got what i need",
  "good luck",
  "best of luck",
  "goodbye",
  "good bye",
  "take care",
];

function isFarewell(text: string): boolean {
  const lower = text.toLowerCase();
  return FAREWELL_PHRASES.some((phrase) => lower.includes(phrase));
}

// The interview is in English. A transcript containing CJK / Hangul / Kana / Cyrillic /
// Arabic script is almost always background noise or a transcription artifact, not the
// candidate — so we drop it instead of letting the AI respond to a phantom turn.
const NON_ENGLISH_SCRIPT = /[぀-ヿ㐀-鿿가-힯Ѐ-ӿ؀-ۿ]/;

function isNonEnglishNoise(text: string): boolean {
  return NON_ENGLISH_SCRIPT.test(text);
}

export async function startRealtimeInterviewer(
  roomName: string,
): Promise<void> {
  console.log(`[Realtime] Starting for room: ${roomName}`);
  console.log(`[Realtime] Model: ${REALTIME_MODEL}`);

  // Connect to MongoDB
  try {
    await connectDB();
    const existing = await Settings.findOne().lean();
    if (!existing) {
      await Settings.create({
        voiceInstructions: DEFAULT_VOICE_INSTRUCTIONS,
        changeHistory: [],
      });
      console.log("[Realtime] Seeded default voice instructions into Settings");
    }
  } catch (err) {
    console.warn(
      "[DB] MongoDB unavailable — transcripts will not be saved:",
      (err as Error).message,
    );
  }

  const interviewId = process.env.INTERVIEW_ID;
  if (!interviewId)
    throw new Error(
      "[Realtime] INTERVIEW_ID env var is required — agent must be spawned by the backend",
    );

  const interviewDoc = await Interview.findById(interviewId).catch(() => null);
  if (!interviewDoc)
    throw new Error(`[Realtime] Interview not found: ${interviewId}`);

  const caseStudyId = interviewDoc?.caseStudyIds?.[0];
  if (!caseStudyId)
    throw new Error(
      "[Realtime] No case study assigned to this interview — cannot start",
    );
  const systemPrompt = await buildSystemPrompt(caseStudyId);
  console.log(`[Realtime] Using case study: ${caseStudyId}`);

  // Connect to LiveKit — same as interviewer.ts
  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
    { identity: "ai-interviewer", name: "AI Interviewer" },
  );
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });
  const token = await at.toJwt();

  const room = new Room();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await room.connect(process.env.LIVEKIT_URL!, token, {
    autoSubscribe: true,
  } as any);
  console.log(`[Realtime] Connected to LiveKit room: ${roomName}`);

  const audioSource = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
  const localTrack = LocalAudioTrack.createAudioTrack(
    "interviewer-audio",
    audioSource,
  );
  if (!room.localParticipant)
    throw new Error("No local participant after connect");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await room.localParticipant.publishTrack(localTrack, { source: 2 } as any);
  console.log("[Realtime] Audio track published");

  // Step 3: open the OpenAI Realtime session and load the AI system prompt.
  // Connected up-front so the model is ready the moment the candidate joins.
  // The prompt comes entirely from the DB (case study + shared voice instructions) —
  // no realtime-specific hardcoding, so both pipelines stay in sync.
  const realtime = new RealtimeSession({ instructions: systemPrompt });

  realtime.on("server-error", (err) => {
    console.error("[Realtime] OpenAI rejected an event:", err);
  });
  realtime.on("close", () => {
    console.log("[Realtime] OpenAI session closed");
  });

  try {
    await realtime.connect();
    console.log("[Realtime] OpenAI session ready — system prompt loaded");
  } catch (err) {
    console.error(
      "[Realtime] Failed to connect to OpenAI — aborting:",
      (err as Error).message,
    );
    await room.disconnect();
    throw err;
  }

  // The Realtime server-event handler is registered further down, once the audio
  // playback queue and turn helpers it depends on have been defined.

  type AgentState = "waiting" | "listening" | "processing" | "speaking";
  let state: AgentState = "processing";

  // Saved history is injected as text into the Realtime session on reconnect
  const history: { role: "user" | "assistant"; content: string }[] = [];
  let greeted = false;
  let turnCount = 0;
  let isRecovery = false;

  // Silence detection — env-tunable so nudge cadence can be adjusted without a rebuild
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceNudgeCount = 0;
  const SILENCE_FIRST_NUDGE_MS = Number(process.env.REALTIME_SILENCE_FIRST_MS);
  const SILENCE_REPEAT_MS = Number(process.env.REALTIME_SILENCE_REPEAT_MS);

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function nudgeCandidate() {
    if (state !== "listening") return;
    silenceNudgeCount++;
    console.log(`[Realtime] Nudge candidate (count=${silenceNudgeCount})`);
    // Make the AI re-engage out loud. Like '[interview started]', the bracketed cue is a
    // directive the model acts on — it won't read the brackets aloud. The AI's spoken
    // nudge is saved to the transcript automatically via onAIResponseDone.
    const cue =
      silenceNudgeCount === 1
        ? "[The candidate has gone quiet. Warmly check in with them in one short sentence — let them know you are still here and it is their turn.]"
        : "[The candidate is still quiet. Gently rephrase your last point or question in one or two short sentences to help them respond.]";
    state = "processing";
    realtime.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: cue }],
      },
    });
    realtime.send({ type: "response.create" });
    armProcessingWatchdog();
  }

  function startSilenceTimer() {
    clearSilenceTimer();
    const delay =
      silenceNudgeCount === 0 ? SILENCE_FIRST_NUDGE_MS : SILENCE_REPEAT_MS;
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      void nudgeCandidate();
    }, delay);
  }

  // Watchdog: after we ask the model for a response we sit in 'processing' until the
  // response starts (response.created). If that never happens — a rejected/lost
  // response.create, an API hiccup — we'd be stuck and stop listening forever. This
  // forces a recovery back to 'listening' so the call can never silently die.
  let processingWatchdog: ReturnType<typeof setTimeout> | null = null;
  const PROCESSING_WATCHDOG_MS = Number(
    process.env.REALTIME_PROCESSING_WATCHDOG_MS,
  );

  function armProcessingWatchdog() {
    if (processingWatchdog) clearTimeout(processingWatchdog);
    processingWatchdog = setTimeout(() => {
      processingWatchdog = null;
      if (state === "processing") {
        console.warn(
          "[Realtime] Response never started — forcing back to listening",
        );
        responseFinished = false;
        finishingScheduled = false;
        state = "listening";
        startSilenceTimer();
      }
    }, PROCESSING_WATCHDOG_MS);
  }

  function disarmProcessingWatchdog() {
    if (processingWatchdog) {
      clearTimeout(processingWatchdog);
      processingWatchdog = null;
    }
  }

  // Watchdog: continuous background noise can keep OpenAI's VAD stuck "in speech" — it
  // fires speech_started but never speech_stopped, so it never commits/transcribes and
  // the candidate is never heard. If speech has been "active" too long with no result,
  // we clear the input buffer to unstick it and restart silence detection so the call
  // recovers instead of freezing. Generous timeout so real long answers aren't cut off.
  let speechWatchdog: ReturnType<typeof setTimeout> | null = null;
  const SPEECH_WATCHDOG_MS = Number(process.env.REALTIME_SPEECH_WATCHDOG_MS);

  function armSpeechWatchdog() {
    if (speechWatchdog) clearTimeout(speechWatchdog);
    speechWatchdog = setTimeout(() => {
      speechWatchdog = null;
      if (state === "listening") {
        console.warn(
          "[Realtime] Speech detection stuck (likely background noise) — clearing input buffer",
        );
        realtime.send({ type: "input_audio_buffer.clear" });
        startSilenceTimer();
      }
    }, SPEECH_WATCHDOG_MS);
  }

  function disarmSpeechWatchdog() {
    if (speechWatchdog) {
      clearTimeout(speechWatchdog);
      speechWatchdog = null;
    }
  }

  // Session recovery: reload history so it can be re-injected into Realtime on reconnect
  if (interviewDoc) {
    try {
      const existingTranscript = await Transcript.findOne({
        interviewId: interviewDoc._id,
      });
      if (existingTranscript && existingTranscript.turns.length > 0) {
        for (const t of existingTranscript.turns) {
          history.push({
            role: t.speaker === Speaker.AI ? "assistant" : "user",
            content: t.text,
          });
        }
        turnCount =
          existingTranscript.turns[existingTranscript.turns.length - 1].turn;
        isRecovery = true;
        console.log(
          `[Realtime] Recovered ${existingTranscript.turns.length} turns from MongoDB`,
        );
      }
    } catch (err) {
      console.warn(
        "[Realtime] Could not load existing transcript:",
        (err as Error).message,
      );
    }
  }

  async function saveTurn(speaker: Speaker, text: string): Promise<void> {
    if (!interviewDoc) return;
    try {
      turnCount++;
      await Transcript.findOneAndUpdate(
        { interviewId: interviewDoc._id },
        {
          $push: {
            turns: { turn: turnCount, speaker, text, timestamp: new Date() },
          },
        },
        { upsert: true },
      );
    } catch (err) {
      console.error("[DB] Failed to save turn:", err);
    }
  }

  // ── Step 5: OpenAI audio → LiveKit playback ──────────────────────────────
  // Audio deltas (response.output_audio.delta) arrive from OpenAI in a fast burst.
  // We slice them into 30 ms frames and feed LiveKit's AudioSource, which paces
  // playback to real time through captureFrame backpressure. A residual buffer
  // carries partial-frame bytes across deltas so we never inject silence gaps
  // mid-word.
  //
  // IMPORTANT — echo safety: we do NOT open the candidate's mic (forward audio to
  // OpenAI) until AI's audio has fully finished playing PLUS a short cooldown,
  // so his own voice coming out of the candidate's speakers can't loop back in and
  // make him talk to himself. `responseFinished` (OpenAI done sending) AND an empty
  // play queue together decide when the turn is really over.
  const BYTES_PER_FRAME = SAMPLES_PER_CHANNEL * 2; // 720 samples × 2 bytes
  // Cooldown before opening the mic after AI stops. Smaller = less chance of dropping
  // the candidate's first words; larger = safer against speaker echo. Env-tunable.
  const PLAYBACK_TAIL_COOLDOWN_MS = Number(
    process.env.REALTIME_PLAYBACK_COOLDOWN_MS,
  );
  const playQueue: AudioFrame[] = [];
  let pcmResidual = Buffer.alloc(0);
  let draining = false;
  let responseFinished = false; // response.done received for the current turn
  let finishingScheduled = false; // guards the single transition back to listening
  let endingCall = false; // farewell — do not resume listening

  async function drainPlayQueue(): Promise<void> {
    if (draining) return;
    draining = true;
    while (playQueue.length > 0) {
      const frame = playQueue.shift()!;
      try {
        await audioSource.captureFrame(frame);
      } catch (err) {
        console.error("[Realtime] captureFrame error:", (err as Error).message);
        break;
      }
    }
    draining = false;
    maybeFinishSpeaking();
  }

  // Transition speaking → listening, but only once OpenAI has finished the turn AND
  // all audio has drained. The cooldown keeps the mic closed a beat longer so the
  // tail of AI's voice in the room doesn't get picked up as a candidate turn.
  function maybeFinishSpeaking(): void {
    if (!responseFinished || draining || playQueue.length > 0) return;
    if (finishingScheduled) return;
    finishingScheduled = true;
    setTimeout(() => {
      if (endingCall) return;
      state = "listening";
      startSilenceTimer();
    }, PLAYBACK_TAIL_COOLDOWN_MS);
  }

  function enqueueAudioDelta(base64Chunk: string): void {
    const combined = Buffer.concat([
      pcmResidual,
      Buffer.from(base64Chunk, "base64"),
    ]);
    let offset = 0;
    while (offset + BYTES_PER_FRAME <= combined.length) {
      const data = new Int16Array(SAMPLES_PER_CHANNEL);
      for (let s = 0; s < SAMPLES_PER_CHANNEL; s++) {
        data[s] = combined.readInt16LE(offset + s * 2);
      }
      playQueue.push(
        new AudioFrame(data, SAMPLE_RATE, NUM_CHANNELS, SAMPLES_PER_CHANNEL),
      );
      offset += BYTES_PER_FRAME;
    }
    pcmResidual = Buffer.from(combined.subarray(offset));
    void drainPlayQueue();
  }

  // Called from the response.done Realtime event — AI finished its turn.
  // Does NOT flip straight to listening; maybeFinishSpeaking() does that once the
  // audio has drained + cooldown, to keep the echo loop closed.
  async function onAIResponseDone(responseText: string): Promise<void> {
    await saveTurn(Speaker.AI, responseText);
    history.push({ role: "assistant", content: responseText });

    if (isFarewell(responseText)) {
      endingCall = true;
      console.log(
        "[Realtime] Farewell detected — ending interview after playback",
      );
      clearSilenceTimer();
      if (interviewDoc) {
        await Interview.updateOne(
          { _id: interviewDoc._id },
          { status: InterviewStatus.COMPLETED, endedAt: new Date() },
        ).catch(() => null);
      }
      // Wait for AI to finish saying goodbye, then hang up.
      const waitForDrain = setInterval(() => {
        if (!draining && playQueue.length === 0) {
          clearInterval(waitForDrain);
          setTimeout(() => room.disconnect(), 2000);
        }
      }, 200);
      return;
    }

    responseFinished = true;
    maybeFinishSpeaking();
  }

  // Called from Realtime event: conversation.item.input_audio_transcription.completed.
  // We only reach here for a real, non-empty transcript, so this is the single place
  // a candidate turn triggers AI to respond (VAD auto-reply is disabled).
  async function onCandidateTurnTranscribed(text: string): Promise<void> {
    silenceNudgeCount = 0;
    clearSilenceTimer();
    state = "processing";
    history.push({ role: "user", content: text });
    await saveTurn(Speaker.CANDIDATE, text);
    // Manually ask the model to respond to the committed audio turn.
    realtime.send({ type: "response.create" });
    armProcessingWatchdog();
  }

  // ── Realtime server-event handler ────────────────────────────────────────
  // GA event names confirmed via test: audio arrives on response.output_audio.delta,
  // the spoken text on response.output_audio_transcript.done, turn end on response.done.
  let currentResponseTranscript = "";
  const seenEventTypes = new Set<string>();
  realtime.on("event", (event: RealtimeEvent) => {
    if (!seenEventTypes.has(event.type)) {
      seenEventTypes.add(event.type);
      console.log(`[Realtime] ← first ${event.type}`);
    }
    switch (event.type) {
      // Candidate turn-taking. We only forward mic audio while state === 'listening',
      // so this only fires on genuine candidate speech (or background noise).
      case "input_audio_buffer.speech_started":
        clearSilenceTimer();
        armSpeechWatchdog(); // recover if this "speech" never ends (steady noise)
        break;

      case "input_audio_buffer.speech_stopped":
        disarmSpeechWatchdog(); // speech ended cleanly — commit/transcription is coming
        break;

      case "conversation.item.input_audio_transcription.completed":
        disarmSpeechWatchdog();
        if (event.transcript && event.transcript.trim()) {
          if (isNonEnglishNoise(event.transcript)) {
            console.log(
              `[Realtime] Ignored non-English/background transcript: "${event.transcript}"`,
            );
            startSilenceTimer(); // nothing usable — resume silence detection so we recover
          } else {
            console.log(`[Realtime] Candidate said: "${event.transcript}"`);
            void onCandidateTurnTranscribed(event.transcript);
          }
        } else {
          startSilenceTimer();
        }
        break;

      // AI's spoken response
      case "response.created":
        disarmProcessingWatchdog(); // the response started — no longer stuck
        state = "speaking";
        currentResponseTranscript = "";
        responseFinished = false;
        finishingScheduled = false;
        pcmResidual = Buffer.alloc(0);
        break;

      case "response.output_audio.delta":
        if (typeof event.delta === "string") enqueueAudioDelta(event.delta);
        break;

      case "response.output_audio_transcript.done":
        if (typeof event.transcript === "string")
          currentResponseTranscript = event.transcript;
        break;

      case "response.done":
        if (currentResponseTranscript.trim()) {
          console.log(`[Realtime] AI said: "${currentResponseTranscript}"`);
          void onAIResponseDone(currentResponseTranscript);
        } else {
          // Cancelled/empty response — just resume listening after any audio drains
          responseFinished = true;
          maybeFinishSpeaking();
        }
        break;
    }
  });

  async function greetCandidate(identity: string): Promise<void> {
    if (greeted) {
      console.log(`[Realtime] Candidate reconnected: ${identity}`);
      await new Promise((r) => setTimeout(r, 1500));
      state = "processing";
      // TODO Step 3: inject reconnect prompt into active Realtime session
      // ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user',
      //   content: [{ type: 'input_text', text: '[You got disconnected and the person just rejoined. Acknowledge the drop briefly and naturally...]' }] } }))
      // ws.send(JSON.stringify({ type: 'response.create' }))
      console.log("[Realtime] TODO: send reconnect message via Realtime API");
      return;
    }

    greeted = true;
    console.log(`[Realtime] Greeting candidate: ${identity}`);

    if (interviewDoc) {
      await Interview.updateOne(
        { _id: interviewDoc._id },
        { status: InterviewStatus.ACTIVE, startedAt: new Date() },
      ).catch(() => null);
    }

    await new Promise((r) => setTimeout(r, 1500));

    // Trigger AI's opening. The system prompt (loaded at session.update) tells the
    // model how to open; '[interview started]' is the silent cue to begin speaking.
    // History injection for recovery is handled in Step 7.
    console.log("[Realtime] Triggering opening greeting");
    state = "processing";
    realtime.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "[interview started]" }],
      },
    });
    realtime.send({ type: "response.create" });
    armProcessingWatchdog();
  }

  // Subscribe to candidate audio and forward to OpenAI Realtime.
  // LiveKit's native layer resamples the 48 kHz track down to SAMPLE_RATE (24 kHz)
  // for us — the frames arrive already as PCM16 24 kHz mono, exactly what OpenAI wants.
  const forwardedTrackSids = new Set<string>();

  function setupAudioForwarding(track: RemoteTrack, identity: string): void {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    if (identity.startsWith("observer-")) return; // never listen to observers
    if (forwardedTrackSids.has(track.sid)) return; // already forwarding this track
    forwardedTrackSids.add(track.sid);
    console.log(`[Realtime] Subscribed to audio from: ${identity}`);

    const audioStream = new AudioStream(track, SAMPLE_RATE, NUM_CHANNELS);
    let framesForwarded = 0;
    void (async () => {
      for await (const frame of audioStream) {
        // Echo safety: only forward the mic while it's genuinely the candidate's
        // turn (state 'listening'). While AI is speaking / thinking / his audio
        // is still draining, we stay silent so his own voice from the candidate's
        // speakers can't loop back in and make him respond to himself.
        if (!realtime.isReady || state !== "listening") continue;

        const pcm = Buffer.from(
          frame.data.buffer,
          frame.data.byteOffset,
          frame.data.byteLength,
        );
        realtime.send({
          type: "input_audio_buffer.append",
          audio: pcm.toString("base64"),
        });

        framesForwarded++;
        if (framesForwarded === 1) {
          console.log(
            `[Realtime] Forwarding candidate audio → OpenAI (${SAMPLE_RATE} Hz PCM16)`,
          );
        } else if (framesForwarded % 500 === 0) {
          // ~15 s of audio per log at 30 ms frames — light heartbeat
          console.log(`[Realtime] …forwarded ${framesForwarded} audio frames`);
        }
      }
      forwardedTrackSids.delete(track.sid);
      console.log(
        `[Realtime] Candidate audio stream ended (${framesForwarded} frames total)`,
      );
    })();
  }

  // Fires for tracks that get subscribed after this handler is registered.
  room.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteTrack, _pub: unknown, participant: RemoteParticipant) => {
      setupAudioForwarding(track, participant.identity);
    },
  );

  // Catch tracks that were ALREADY subscribed before we got here — e.g. the candidate
  // was in the room before the agent started, so their mic subscribed during
  // realtime.connect() and the TrackSubscribed event fired before this handler existed.
  // Without this, we'd never forward their audio and OpenAI would hear pure silence.
  function attachExistingTracks(participant: RemoteParticipant): void {
    for (const pub of participant.trackPublications.values()) {
      if (pub.subscribed && pub.track && pub.kind === TrackKind.KIND_AUDIO) {
        setupAudioForwarding(pub.track as RemoteTrack, participant.identity);
      }
    }
  }

  room.on(
    RoomEvent.ParticipantDisconnected,
    (participant: RemoteParticipant) => {
      if (participant.identity.startsWith("observer-")) return;
      console.log(
        `[Realtime] Candidate disconnected: ${participant.identity} — pausing`,
      );
      clearSilenceTimer();
      // TODO Step 3: pause input on Realtime session (keep WebSocket open, history stays in memory)
      state = "waiting";
    },
  );

  room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    if (participant.identity.startsWith("observer-")) {
      console.log(
        `[Realtime] Observer joined — skipping greeting: ${participant.identity}`,
      );
      return;
    }
    attachExistingTracks(participant); // in case their mic is already published/subscribed
    void greetCandidate(participant.identity);
  });

  // Safety net: greet + start forwarding for a candidate already in the room when the
  // agent starts. attachExistingTracks is the critical bit — their mic track was
  // subscribed before our TrackSubscribed handler existed.
  const existingParticipants = [...room.remoteParticipants.values()].filter(
    (p) => !p.identity.startsWith("observer-"),
  );
  if (existingParticipants.length > 0) {
    console.log("[Realtime] Candidate already in room — greeting immediately");
    attachExistingTracks(existingParticipants[0]);
    void greetCandidate(existingParticipants[0].identity);
  }

  room.on(RoomEvent.Disconnected, () => {
    console.log("[Realtime] Room disconnected");
    clearSilenceTimer();
    realtime.close();
    if (interviewDoc) {
      Interview.updateOne(
        { _id: interviewDoc._id },
        { status: InterviewStatus.COMPLETED, endedAt: new Date() },
      ).catch(() => null);
    }
  });

  console.log("[Realtime] Waiting for candidate...");
  await new Promise<void>((resolve) => {
    room.on(RoomEvent.Disconnected, () => resolve());
  });
}
