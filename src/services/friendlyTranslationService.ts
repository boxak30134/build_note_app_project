/**
 * FRIENDLY_TRANSLATION_GUIDE.md: 사용자 친화적 무설정 번역 및 경량 AI 연동 모듈
 * Tier 1: 로컬 적응형 사전 (오프라인, 0ms)
 * Tier 2: Google AI Studio (Gemini Flash) 카드 불필요 무료 개인 키 (원클릭 발급)
 * Tier 3: 클라이언트 공개 무키(No-Key) 엔드포인트 (Zero-Config, 기본 모드)
 */

export type TranslationEngine = 'local' | 'gemini' | 'public_free';

export interface FriendlyTranslationResult {
  success: boolean;
  translatedText?: string;
  engine: TranslationEngine;
  confidence: number;
  errorMessage?: string;
}

/**
 * 1. 공개 무키(No-Key) 엔드포인트를 통한 기본 번역 (설정 없이 즉시 작동)
 */
export async function translateViaPublicEndpoint(text: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`공개 번역 서버 응답 실패 (${response.status})`);
  }

  const data = await response.json();
  // gtx 응답 포맷: [[["번역문", "원문", null, null, ...]], ...]
  if (Array.isArray(data) && Array.isArray(data[0])) {
    const fullText = data[0].map((item: any) => (Array.isArray(item) ? item[0] : '')).join('');
    if (fullText.trim()) return fullText.trim();
  }
  throw new Error('응답 데이터를 파싱할 수 없습니다.');
}

/**
 * 2. Google AI Studio (Gemini Flash) API 호출 (카드 불필요 무료 키)
 */
export async function translateViaGemini(
  text: string,
  apiKey: string,
  contextSentence?: string
): Promise<string> {
  const cleanKey = apiKey.trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(cleanKey)}`;

  const prompt = `You are a professional academic translator specializing in mathematics and computer science.
Translate the following English text to Korean accurately, maintaining academic terminology (e.g., ring -> 환, field -> 체).
Surrounding Context: "${contextSentence || ''}"
Text to translate: "${text}"

Output ONLY the translated Korean text without explanation or markdown quotes.`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 200,
      },
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const msg = errData.error?.message || `HTTP ${response.status}`;
    if (response.status === 400 || response.status === 403) {
      throw new Error(`Gemini 키 오류: ${msg}`);
    }
    throw new Error(`Gemini 번역 실패: ${msg}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidate) throw new Error('번역 결과를 생성하지 못했습니다.');
  return candidate.trim();
}

/**
 * 메인 통합 실행 함수
 */
export async function executeFriendlyTranslation({
  text,
  surroundingSentence,
  geminiApiKey,
  localMeaning,
}: {
  text: string;
  surroundingSentence: string;
  geminiApiKey?: string | null;
  localMeaning?: string | null;
}): Promise<FriendlyTranslationResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      success: false,
      engine: 'public_free',
      confidence: 0,
      errorMessage: '번역할 내용이 비어있습니다.',
    };
  }

  // Tier 1: 로컬 적응형 다의어(문맥·사용자 학습) 매칭이 유효한 경우
  if (localMeaning) {
    return {
      success: true,
      translatedText: localMeaning,
      engine: 'local',
      confidence: 98,
    };
  }

  // Tier 2: 사용자가 등록한 Gemini 키가 있는 경우 우선 사용
  if (geminiApiKey && geminiApiKey.trim() !== '') {
    try {
      const result = await translateViaGemini(trimmed, geminiApiKey, surroundingSentence);
      return {
        success: true,
        translatedText: result,
        engine: 'gemini',
        confidence: 95,
      };
    } catch (err: any) {
      console.warn('Gemini 번역 실패, 기본 공개 엔진으로 자동 폴백합니다:', err.message);
      // Gemini 키 에러 발생 시 사용자 작업이 중단되지 않도록 Tier 3로 자동 폴백
    }
  }

  // Tier 3: 별도 설정 없는 기본 공개 엔진 (Zero-Config)
  try {
    const publicResult = await translateViaPublicEndpoint(trimmed);
    return {
      success: true,
      translatedText: publicResult,
      engine: 'public_free',
      confidence: 85,
    };
  } catch {
    return {
      success: false,
      engine: 'public_free',
      confidence: 0,
      errorMessage: '오프라인 상태이거나 네트워크 연결이 원활하지 않습니다.',
    };
  }
}

