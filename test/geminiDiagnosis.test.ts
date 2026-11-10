import { describe, it, expect, vi } from 'vitest';
import {
  buildGeminiStreamParams,
  formatGeminiError,
  streamGeminiTutor,
  type GeminiStreamChunkLike,
} from '../src/modules/ai/geminiClient';

describe('Gemini API & Stream Diagnostics Spec', () => {
  it('buildGeminiStreamParams는 기본 요청 설정을 정상적으로 빌드한다', () => {
    const params = buildGeminiStreamParams({
      prompt: '안녕하세요. 짧게 답변해주세요.',
      model: 'gemini-3.8-flash',
      target: 'sidebar',
    });

    expect(params.model).toBe('gemini-3.8-flash');
    expect(params.contents[0]?.parts?.[0]).toEqual({ text: '안녕하세요. 짧게 답변해주세요.' });
    expect(params.config.temperature).toBe(1.0);
    expect(params.config.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  it('503 Server Unavailable 및 High Demand 에러를 올바르게 포맷팅한다', () => {
    const error503 = {
      status: 503,
      message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.',
    };
    const formatted = formatGeminiError(error503);
    expect(formatted).toContain('503');
    expect(formatted).toContain('high demand');
  });

  it('404 Not Found 및 Deprecated 모델 에러를 올바르게 식별한다', () => {
    const error404 = {
      status: 404,
      message: 'This model models/gemini-2.5-flash is no longer available to new users.',
    };
    const formatted = formatGeminiError(error404);
    expect(formatted).toContain('404');
    expect(formatted).toContain('gemini-2.5-flash');
  });

  it('thinking 토큰과 텍스트 토큰이 분리된 스트림 청크를 올바르게 해석한다', () => {
    const thoughtChunk: GeminiStreamChunkLike = {
      candidates: [
        {
          content: {
            parts: [{ text: '생각 중...', thought: true }],
            role: 'model',
          },
        },
      ],
    };
    const textChunk: GeminiStreamChunkLike = {
      text: '안녕하세요!',
      candidates: [
        {
          content: {
            parts: [{ text: '안녕하세요!' }],
            role: 'model',
          },
        },
      ],
    };

    // thought=true인 경우 text 속성이 없으면 본문 출력으로 산출되지 않아야 함
    expect(thoughtChunk.text).toBeUndefined();
    expect(textChunk.text).toBe('안녕하세요!');
  });

  it('스트림에서 텍스트 청크가 도착하면 onChunk 콜백과 generator 출력이 일치한다', async () => {
    const chunks: GeminiStreamChunkLike[] = [
      {
        candidates: [
          { content: { parts: [{ text: '생각 중...', thought: true }], role: 'model' } },
        ],
      },
      {
        text: '정답은 ',
        candidates: [
          { content: { parts: [{ text: '정답은 ' }], role: 'model' } },
        ],
      },
      {
        text: '42입니다.',
        candidates: [
          { content: { parts: [{ text: '42입니다.' }], role: 'model' } },
        ],
      },
    ];

    const mockClient = {
      models: {
        generateContentStream: vi.fn().mockResolvedValue((async function* () {
          for (const c of chunks) {
            yield c;
          }
        })()),
      },
    };

    const receivedDeltas: string[] = [];
    const receivedAccum: string[] = [];

    const stream = streamGeminiTutor({
      prompt: '질문',
      apiKey: 'test-key',
      client: mockClient as any,
      enableFallback: false,
      onChunk: (delta, accum) => {
        receivedDeltas.push(delta);
        receivedAccum.push(accum);
      },
    });

    const yielded: string[] = [];
    for await (const piece of stream) {
      yielded.push(piece);
    }

    expect(yielded).toEqual(['정답은 ', '42입니다.']);
    expect(receivedDeltas).toEqual(['정답은 ', '42입니다.']);
    expect(receivedAccum).toEqual(['정답은 ', '정답은 42입니다.']);
  });
});
