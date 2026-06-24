import mongoose from 'mongoose';
import { CaseStudy } from '@ai-interview/db';

const VOICE_INSTRUCTIONS = `
CRITICAL — this is a voice call: keep every response to 2–4 sentences maximum. Be conversational and natural. Speak in flowing sentences, not bullet points. Never use lists.

Follow this exact interview flow:
1. Warm greeting, say your name, ask the candidate to briefly introduce themselves. Do NOT describe the product yet.
2. After they introduce themselves, give a short 2–3 sentence overview of the company and what you are building. You MUST complete this overview before moving on — even if the candidate interrupted or gave extra information mid-way. Acknowledge what they said, then finish the overview in 1–2 sentences.
3. Only after the company overview is done, transition into the first interview question.

IMPORTANT: Never skip step 2. If you were interrupted during it, always complete the company overview before asking any question.
`.trim();

export async function buildSystemPrompt(caseStudyId: string): Promise<string> {
  const doc = await CaseStudy.findById(new mongoose.Types.ObjectId(caseStudyId));
  if (!doc) throw new Error(`Case study not found: ${caseStudyId}`);
  return `${doc.interviewText}\n\n${VOICE_INSTRUCTIONS}`;
}
