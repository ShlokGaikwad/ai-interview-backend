import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

export interface TranscriptSegment {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
}

export interface DeepgramHandle {
  sendAudio: (data: Buffer) => void;
  close: () => void;
}

export function createDeepgramStream(
  onTranscript: (segment: TranscriptSegment) => void,
  onError: (err: Error) => void,
): DeepgramHandle {
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);

  const conn = deepgram.listen.live({
    model: 'nova-2',
    language: 'en',
    smart_format: true,
    interim_results: true,
    utterance_end_ms: 3000,
    vad_events: true,
    encoding: 'linear16',
    sample_rate: 16000,
    channels: 1,
  });

  let ready = false;

  // Send a keepalive every 8s so Deepgram doesn't close during agent speech
  const keepAliveTimer = setInterval(() => {
    if (ready) conn.keepAlive();
  }, 8000);

  conn.on(LiveTranscriptionEvents.Open, () => {
    ready = true;
    console.log('[STT] Deepgram ready');
  });

  conn.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data?.channel?.alternatives?.[0];
    if (!alt?.transcript) return;

    onTranscript({
      text: alt.transcript,
      isFinal: data.is_final ?? false,
      speechFinal: data.speech_final ?? false,
    });
  });

  conn.on(LiveTranscriptionEvents.Error, (err: unknown) => {
    onError(err instanceof Error ? err : new Error(String(err)));
  });

  conn.on(LiveTranscriptionEvents.Close, () => {
    console.log('[STT] Deepgram closed');
    clearInterval(keepAliveTimer);
    ready = false;
  });

  return {
    sendAudio: (data: Buffer) => {
      if (ready) conn.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    },
    close: () => {
      clearInterval(keepAliveTimer);
      conn.finish();
    },
  };
}
