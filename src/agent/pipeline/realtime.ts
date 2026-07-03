import "dotenv/config";
import WebSocket from "ws";
import { EventEmitter } from "node:events";

const REALTIME_MODEL = process.env.REALTIME_MODEL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

export interface RealtimeConfig {
  instructions: string;
  voice?: string;
  /** playback speed for AI's voice (0.25–1.5, 1.0 = normal) */
  speed?: number;
  /** silence the server-VAD waits for before treating candidate as done (ms) */
  silenceMs?: number;
}

// Generic server event shape — the Realtime API always sends a `type` field
export interface RealtimeEvent {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Thin wrapper around the OpenAI Realtime WebSocket.
 *
 * Step 3 scope: connect + configure the session and prove it works.
 * Audio append (Step 4), audio playback (Step 5) and transcript events (Step 6)
 * are consumed by the caller through the emitted `event` stream.
 *
 * Events emitted:
 *   'ready'        → session.updated received, safe to send audio
 *   'event'        → every other server event (audio deltas, transcripts, response.done…)
 *   'server-error' → an { type: 'error' } event from OpenAI (bad config, etc.)
 *   'close'        → socket closed (code, reason)
 *   'error'        → transport-level socket error
 */
export class RealtimeSession extends EventEmitter {
  private ws: WebSocket | null = null;
  private configured = false;

  constructor(private config: RealtimeConfig) {
    super();
  }

  /** Opens the socket and resolves once the session config is accepted. */
  connect(): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;
    console.log(`[Realtime] Connecting → ${url}`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      });
      this.ws = ws;

      const timeout = setTimeout(() => {
        reject(
          new Error(
            "[Realtime] Connection timed out after 15s (no session.updated)",
          ),
        );
        ws.terminate();
      }, 15000);

      ws.on("open", () => {
        console.log(`[Realtime] WebSocket open — model ${REALTIME_MODEL}`);
        this.sendSessionUpdate();
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        let event: RealtimeEvent;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          console.warn(
            "[Realtime] Non-JSON message:",
            raw.toString().slice(0, 200),
          );
          return;
        }
        this.handleEvent(event, () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      ws.on("error", (err: Error) => {
        clearTimeout(timeout);
        console.error("[Realtime] WebSocket transport error:", err.message);
        this.emit("error", err);
        reject(err);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        console.log(
          `[Realtime] WebSocket closed (${code}) ${reason.toString()}`,
        );
        this.emit("close", code, reason.toString());
        // If the socket closes before the session is configured (e.g. quota/auth
        // rejection), fail fast with the real reason instead of waiting for the
        // 15s connect timeout and reporting a misleading "timed out".
        if (!this.configured) {
          clearTimeout(timeout);
          reject(
            new Error(
              `[Realtime] Connection closed before ready (${code}): ${reason.toString() || "no reason given"}`,
            ),
          );
        }
      });
    });
  }

  private sendSessionUpdate(): void {
    // GA Realtime API shape (/v1/realtime): audio config is nested under `audio`,
    // formats are objects, and modalities are declared via `output_modalities`.
    const voice = process.env.REALTIME_VOICE;
    const speed = Number(
      process.env.REALTIME_SPEED,
    );
    // Higher threshold + longer trailing silence = brief backchannels ("yeah",
    // "mm-hm") don't get treated as a full turn and restart AI.
    const vadThreshold = Number(process.env.REALTIME_VAD_THRESHOLD);
    const vadSilenceMs = Number(process.env.REALTIME_VAD_SILENCE_MS);

    // Turn detection. `semantic_vad` (default) uses a model to judge whether a real
    // turn happened — it ignores background noise, breaths and coughs far better than
    // raw-volume `server_vad`, so it doesn't need per-environment threshold tuning.
    // Either way we disable auto-reply: noise can trip an empty commit, and we don't
    // want the AI answering itself — we trigger response.create ourselves on a real
    // transcript. Switch with REALTIME_VAD_MODE=server if ever needed.
    const vadMode = process.env.REALTIME_VAD_MODE;
    const turnDetection =
      vadMode === "server"
        ? {
            type: "server_vad",
            threshold: vadThreshold,
            prefix_padding_ms: 300,
            silence_duration_ms: vadSilenceMs,
            create_response: false,
            interrupt_response: false,
          }
        : {
            type: "semantic_vad",
            eagerness: process.env.REALTIME_VAD_EAGERNESS, // low|medium|high|auto
            create_response: false,
            interrupt_response: false,
          };

    const session = {
      type: "realtime",
      output_modalities: ["audio"],
      instructions: this.config.instructions,
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          // gpt-4o-mini-transcribe hallucinates far less than whisper-1 on silence/noise
          // (whisper invents "Thank you" and random other-language text). Pin to English.
          transcription: {
            model: process.env.REALTIME_TRANSCRIBE_MODEL,
            language: "en",
          },
          turn_detection: turnDetection,
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice,
          speed,
        },
      },
    };
    this.send({ type: "session.update", session });
    console.log(
      `[Realtime] Sent session.update (voice: ${voice}, speed: ${speed}, vad: ${turnDetection.type})`,
    );
  }

  private handleEvent(event: RealtimeEvent, onReady: () => void): void {
    switch (event.type) {
      case "session.created":
        console.log(
          "[Realtime] session.created — session id:",
          event.session?.id ?? "(unknown)",
        );
        break;

      case "session.updated":
        if (!this.configured) {
          this.configured = true;
          console.log("[Realtime] session.updated — configuration accepted ✓");
          this.emit("ready");
          onReady();
        }
        break;

      case "error":
        console.error(
          "[Realtime] Server error event:\n",
          JSON.stringify(event.error ?? event, null, 2),
        );
        this.emit("server-error", event.error ?? event);
        break;

      default:
        // Audio deltas, transcripts, response.done, etc. — handed to the caller
        this.emit("event", event);
    }
  }

  /** Send any client event to OpenAI (JSON-serialised). */
  send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.warn(
        "[Realtime] Dropped send — socket not open:",
        (payload as any)?.type,
      );
    }
  }

  get isReady(): boolean {
    return this.configured;
  }

  close(): void {
    this.ws?.close();
  }
}
