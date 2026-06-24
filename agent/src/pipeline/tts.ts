import https from 'https';

// Uses the ElevenLabs REST API directly to get raw PCM audio (pcm_16000).
// This avoids SDK version uncertainty around output_format support.
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });

    const req = https.request(
      {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}?output_format=pcm_16000`,
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY!,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`ElevenLabs error: ${res.statusCode} ${res.statusMessage}`));
          res.resume();
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
