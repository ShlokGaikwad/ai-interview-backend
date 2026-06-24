import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface LLMProvider {
  complete(systemPrompt: string, messages: Message[]): Promise<string>;
}

class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async complete(systemPrompt: string, messages: Message[]): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: process.env.LLM_MODEL ?? 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    });
    return res.choices[0].message.content ?? '';
  }
}

class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set — switch LLM_PROVIDER=openai or add the key');
    }
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async complete(systemPrompt: string, messages: Message[]): Promise<string> {
    const res = await this.client.messages.create({
      model: process.env.LLM_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });
    const block = res.content[0];
    return block.type === 'text' ? block.text : '';
  }
}

const provider: LLMProvider = (() => {
  const p = (process.env.LLM_PROVIDER ?? 'openai').toLowerCase();
  if (p === 'anthropic') return new AnthropicProvider();
  return new OpenAIProvider();
})();

export async function getNextResponse(systemPrompt: string, messages: Message[]): Promise<string> {
  return provider.complete(systemPrompt, messages);
}
