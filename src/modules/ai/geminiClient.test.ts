import { describe, expect, it, vi } from 'vitest';
import {
  ACADEMIC_TUTOR_SYSTEM_PROMPT,
  askGeminiTutor,
  BUBBLE_MAX_OUTPUT_TOKENS,
  buildAcademicSystemInstruction,
  buildGeminiStreamParams,
  formatGeminiError,
  GEMINI_FALLBACK_MODEL,
  GEMINI_PRIMARY_MODEL,
  GEMINI_TEMPERATURE,
  GEMINI_THINKING_CONFIG,
  normalizeAcademicLatex,
  parseMathSegments,
  resolveGeminiApiKey,
  resolveMaxOutputTokens,
  SIDEBAR_MAX_OUTPUT_TOKENS,
  streamGeminiTutor,
  type GeminiClientLike,
  type GeminiStreamChunkLike,
} from './index';

function createAsyncStream(chunks: GeminiStreamChunkLike[]): AsyncIterable<GeminiStreamChunkLike> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield c;
      }
    },
  };
}

describe('Gemini 기반 학술 튜터 및 AI 연계 모듈 (CLAUDE.md §9)', () => {
  it('6.1 파라미터 규격: 기본 모델 gemini-3.8-flash, temperature 1.0, thinkingLevel low, 토큰 제한(말풍선 800 / 사이드바 1500)을 준수한다', () => {
    const bubbleParams = buildGeminiStreamParams({
      prompt: '연속함수의 중간값 정리를 서술하라.',
      target: 'bubble',
    });

    expect(bubbleParams.model).toBe(GEMINI_PRIMARY_MODEL);
    expect(bubbleParams.model).toBe('gemini-3.8-flash');
    expect(bubbleParams.config.temperature).toBe(GEMINI_TEMPERATURE);
    expect(bubbleParams.config.temperature).toBe(1.0);
    expect(bubbleParams.config.thinkingConfig).toEqual(GEMINI_THINKING_CONFIG);
    expect(bubbleParams.config.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(bubbleParams.config.maxOutputTokens).toBe(BUBBLE_MAX_OUTPUT_TOKENS);
    expect(bubbleParams.config.maxOutputTokens).toBe(800);

    const sidebarParams = buildGeminiStreamParams({
      prompt: '선형변환의 차원 정리(Rank-Nullity Theorem)를 증명하라.',
      target: 'sidebar',
    });
    expect(sidebarParams.config.maxOutputTokens).toBe(SIDEBAR_MAX_OUTPUT_TOKENS);
    expect(sidebarParams.config.maxOutputTokens).toBe(1500);

    // 상한 초과 요청 시에도 800 / 1500 으로 클램핑
    expect(resolveMaxOutputTokens('bubble', 2000)).toBe(800);
    expect(resolveMaxOutputTokens('sidebar', 3000)).toBe(1500);
  });

  it('6.2 학술 튜터 시스템 프롬프트(systemInstruction)를 모든 요청에 반드시 주입한다', () => {
    const params = buildGeminiStreamParams({
      prompt: '해석학 질문',
      systemContext: '[현재 노트: 실해석학 개론]\n코시 수열의 정의',
      target: 'sidebar',
    });

    expect(params.config.systemInstruction).toContain(ACADEMIC_TUTOR_SYSTEM_PROMPT);
    expect(params.config.systemInstruction).toContain('너는 대학 학부 전공생(수학, 수리과학, 컴퓨터과학, 공학 등)을 지원하는 엄밀하고 간결한 학술 튜터이다.');
    expect(params.config.systemInstruction).toContain('KaTeX 렌더링 무결성 (Strict LaTeX Formatting)');
    expect(params.config.systemInstruction).toContain('\\begin{aligned} ... \\end{aligned}');
    expect(params.config.systemInstruction).toContain('[현재 노트: 실해석학 개론]');
    expect(buildAcademicSystemInstruction()).toBe(ACADEMIC_TUTOR_SYSTEM_PROMPT);
  });

  it('ai.models.generateContentStream을 사용해 청크 단위로 스트리밍 응답을 생성하고 Chunk received 로그를 남긴다', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunkList = [
      { text: '콤팩트 거리공간 $(X, d)$ 에서 ' },
      { text: '연속함수 $f: X \\to Y$ 는 ' },
      { text: '균등연속(uniformly continuous)이다.' },
    ];
    const generateContentStream = vi.fn().mockResolvedValue(createAsyncStream(chunkList));
    const mockClient: GeminiClientLike = {
      models: { generateContentStream },
    };

    const startTime = performance.now();
    let firstChunkLatencyMs: number | null = null;
    const receivedChunks: string[] = [];

    try {
      const fullAnswer = await askGeminiTutor({
        apiKey: 'AIzaSyTestKey12345',
        client: mockClient,
        target: 'bubble',
        prompt: '콤팩트 공간에서 정의된 연속함수가 균등연속임을 설명하라.',
        onChunk: (delta) => {
          if (firstChunkLatencyMs === null) {
            firstChunkLatencyMs = performance.now() - startTime;
          }
          receivedChunks.push(delta);
        },
      });

      expect(generateContentStream).toHaveBeenCalledTimes(1);
      expect(generateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-3.8-flash',
          config: expect.objectContaining({
            temperature: 1.0,
            thinkingConfig: { thinkingLevel: 'low' },
            maxOutputTokens: 800,
            systemInstruction: ACADEMIC_TUTOR_SYSTEM_PROMPT,
          }),
        }),
      );
      expect(receivedChunks).toEqual([
        '콤팩트 거리공간 $(X, d)$ 에서 ',
        '연속함수 $f: X \\to Y$ 는 ',
        '균등연속(uniformly continuous)이다.',
      ]);
      expect(fullAnswer).toBe('콤팩트 거리공간 $(X, d)$ 에서 연속함수 $f: X \\to Y$ 는 균등연속(uniformly continuous)이다.');
      expect(firstChunkLatencyMs).not.toBeNull();
      expect(firstChunkLatencyMs!).toBeLessThan(1000);
      expect(logSpy).toHaveBeenCalledWith('Chunk received:', chunkList[0]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('기본 모델(gemini-3.8-flash)이 503/404 에러를 반환하면 대안 모델 체인으로 자동 폴백한다', async () => {
    const generateContentStream = vi
      .fn()
      .mockRejectedValueOnce(new Error('503 This model is currently experiencing high demand'))
      .mockRejectedValueOnce(new Error('404 Model models/gemini-2.5-flash is not found'))
      .mockResolvedValueOnce(createAsyncStream([{ text: '대안 모델 응답: $\\forall \\epsilon > 0$' }]));

    const mockClient: GeminiClientLike = {
      models: { generateContentStream },
    };

    const chunks: string[] = [];
    for await (const chunk of streamGeminiTutor({
      apiKey: 'test-gemini-key',
      client: mockClient,
      prompt: '극한의 입실론-델타 정의는?',
      target: 'sidebar',
    })) {
      chunks.push(chunk);
    }

    expect(generateContentStream).toHaveBeenCalledTimes(3);
    expect(generateContentStream.mock.calls[0][0].model).toBe(GEMINI_PRIMARY_MODEL);
    expect(generateContentStream.mock.calls[1][0].model).toBe(GEMINI_FALLBACK_MODEL);
    expect(generateContentStream.mock.calls[2][0].model).toBe('gemini-3.6-flash');
    expect(chunks.join('')).toBe('대안 모델 응답: $\\forall \\epsilon > 0$');
  });

  it('thinkingConfig가 400 Invalid Argument 에러를 유발하면 기본값(thinkingConfig 제거)으로 안전하게 폴백한다', async () => {
    const err400 = Object.assign(new Error('400 Invalid argument: thinkingLevel is not supported'), { status: 400 });
    const generateContentStream = vi
      .fn()
      .mockRejectedValueOnce(err400)
      .mockResolvedValueOnce(createAsyncStream([{ text: '기본 thinking 설정 응답' }]));

    const mockClient: GeminiClientLike = {
      models: { generateContentStream },
    };

    const answer = await askGeminiTutor({
      apiKey: 'test-gemini-key',
      client: mockClient,
      prompt: '선형독립의 정의는?',
      target: 'bubble',
    });

    expect(generateContentStream).toHaveBeenCalledTimes(2);
    expect(generateContentStream.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(generateContentStream.mock.calls[1][0].config.thinkingConfig).toBeUndefined();
    expect(answer).toBe('기본 thinking 설정 응답');
  });

  it('멀티모달 메시지(텍스트 + 올가미 캡처 이미지 Base64)를 Gemini Content 포맷으로 정확히 변환한다', () => {
    const params = buildGeminiStreamParams({
      target: 'bubble',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '[주석 대상: 손글씨 수식]' },
            { type: 'file', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
          ],
        },
        {
          role: 'assistant',
          content: '이전 답변입니다.',
        },
      ],
    });

    expect(params.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: '[주석 대상: 손글씨 수식]' },
          { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } },
        ],
      },
      {
        role: 'model',
        parts: [{ text: '이전 답변입니다.' }],
      },
    ]);
  });

  it('환경변수(VITE_GEMINI_API_KEY) 주입 시 앞 4자리를 콘솔에 로깅하고 키를 반환한다', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('VITE_GEMINI_API_KEY', 'AIzaSyEnvKey9999');
    try {
      expect(await resolveGeminiApiKey()).toBe('AIzaSyEnvKey9999');
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini Env Check] import.meta.env.VITE_GEMINI_API_KEY:',
        'AIza****',
      );
    } finally {
      vi.unstubAllEnvs();
      logSpy.mockRestore();
    }
  });

  it('KaTeX 수식 정규화 및 에러 메시지 포맷팅이 정상 동작한다', () => {
    const raw = '정리: $x \\in \\mathbb{R}$ 는 실수이다.\n$$\\begin{align*} a &= b \\\\ c &= d \\end{align*}$$';
    const normalized = normalizeAcademicLatex(raw);
    expect(normalized).toContain('\\begin{aligned}');
    expect(normalized).not.toContain('\\begin{align*}');

    const segments = parseMathSegments(raw);
    expect(segments.some((s) => s.type === 'inline-math' && s.html.includes('katex'))).toBe(true);
    expect(segments.some((s) => s.type === 'block-math' && s.html.includes('katex-display'))).toBe(true);

    const formattedErr = formatGeminiError(
      new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}'),
    );
    expect(formattedErr).toContain('Gemini 오류 (503): This model is currently experiencing high demand.');
  });
});
