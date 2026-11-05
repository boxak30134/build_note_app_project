import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GoogleGenAI } from '@google/genai';

function loadDotEnv() {
  for (const name of ['.env.local', '.env']) {
    const p = resolve(process.cwd(), name);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      const val = m[2].replace(/^['"]|['"]$/g, '').trim();
      if (val && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

loadDotEnv();

const apiKey = (
  process.env.VITE_GEMINI_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  ''
).trim();

console.log(
  '[Gemini Env Check] VITE_GEMINI_API_KEY prefix:',
  apiKey ? `${apiKey.slice(0, 4)}****` : 'MISSING',
);

if (!apiKey) {
  console.error('Error: VITE_GEMINI_API_KEY or GEMINI_API_KEY is not set.');
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey,
  httpOptions: {
    timeout: 15000,
    retryOptions: { attempts: 1 },
  },
});

const SYSTEM_PROMPT = `너는 대학 학부 전공생(수학, 수리과학, 컴퓨터과학, 공학 등)을 지원하는 엄밀하고 간결한 학술 튜터이다.
직관적 결론을 첫 문장에 명시한 뒤 KaTeX 호환 수식($...$, $$...$$)으로 간결히 설명하라.`;

async function tryStream(model, thinkingConfig) {
  console.log(`\n[Test] Calling generateContentStream -> model=${model}, thinkingConfig=${JSON.stringify(thinkingConfig)}`);
  const config = {
    systemInstruction: SYSTEM_PROMPT,
    temperature: 1.0,
    maxOutputTokens: 1500,
    httpOptions: {
      timeout: 15000,
      retryOptions: { attempts: 1 },
    },
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };

  const stream = await ai.models.generateContentStream({
    model,
    contents: [{ role: 'user', parts: [{ text: '연속함수의 중간값 정리(Intermediate Value Theorem)를 3문장 이내로 정의하라.' }] }],
    config,
  });

  let fullText = '';
  for await (const chunk of stream) {
    console.log('Chunk received:', chunk);
    const text = chunk.text ?? chunk.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    fullText += text;
  }
  return fullText;
}

async function main() {
  const candidates = [
    { model: 'gemini-3.8-flash', thinkingConfig: { thinkingLevel: 'low' } },
    { model: 'gemini-3.6-flash', thinkingConfig: { thinkingLevel: 'low' } },
    { model: 'gemini-3.5-flash-lite', thinkingConfig: { thinkingLevel: 'low' } },
    { model: 'gemini-2.5-flash', thinkingConfig: { thinkingLevel: 'low' } },
    { model: 'gemini-2.5-flash', thinkingConfig: undefined },
  ];

  for (const candidate of candidates) {
    try {
      const answer = await tryStream(candidate.model, candidate.thinkingConfig);
      if (answer.trim()) {
        console.log('\n[Success] Model:', candidate.model, 'thinkingConfig:', JSON.stringify(candidate.thinkingConfig));
        console.log('[Final Answer]:\n' + answer);
        return;
      }
    } catch (err) {
      console.warn(
        `[Fallback] Failed with model=${candidate.model}, thinkingConfig=${JSON.stringify(candidate.thinkingConfig)} ->`,
        err?.status ?? '',
        err?.message ?? err,
      );
    }
  }

  console.error('[Fatal] All Gemini model/config candidates failed.');
  process.exit(1);
}

main();
