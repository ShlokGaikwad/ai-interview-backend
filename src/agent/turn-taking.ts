// End-of-turn detection is handled by Deepgram's speech_final signal in interviewer.ts.
// isEndOfTurn is kept here for any future custom VAD or silence-threshold logic.
export function isEndOfTurn(_transcript: string, _silenceMs: number): boolean {
  return false;
}

export function isHoldRequest(transcript: string): boolean {
  const holdPhrases = [
    'give me a minute',
    'give me a moment',
    'one second',
    'let me think',
    'hold on',
    'just a moment',
    'give me a sec',
    'let me pause',
    'hang on',
  ];
  const lower = transcript.toLowerCase();
  return holdPhrases.some((phrase) => lower.includes(phrase));
}
