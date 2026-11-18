export type FeedbackCategory = '버그 제보' | '불편사항' | '기능 제안';

export interface FeedbackEnvInfo {
  userAgent?: string;
  resolution?: string;
  viewport?: string;
  pwaStandalone?: boolean;
  language?: string;
}

export interface FeedbackRequestBody {
  category?: string;
  title?: string;
  description?: string;
  author?: string;
  envInfo?: FeedbackEnvInfo;
}

export interface VercelLikeRequest {
  method?: string;
  body?: unknown;
}

export interface VercelLikeResponse {
  status: (code: number) => VercelLikeResponse;
  json: (data: unknown) => void;
  setHeader?: (name: string, value: string) => void;
}

declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

const GITHUB_ISSUES_ENDPOINT =
  'https://api.github.com/repos/boxak30134/build_note_app_project/issues';

const VALID_CATEGORIES: readonly FeedbackCategory[] = ['버그 제보', '불편사항', '기능 제안'];

export function resolveIssueLabels(category: FeedbackCategory): string[] {
  switch (category) {
    case '버그 제보':
      return ['bug', 'feedback'];
    case '기능 제안':
      return ['enhancement', 'feedback'];
    case '불편사항':
    default:
      return ['feedback'];
  }
}

function sanitizeInline(value: string, maxLen: number): string {
  return value.replace(/\r\n/g, '\n').trim().slice(0, maxLen);
}

export function buildIssuePayload(raw: FeedbackRequestBody): {
  title: string;
  body: string;
  labels: string[];
} {
  const category: FeedbackCategory = VALID_CATEGORIES.includes(raw.category as FeedbackCategory)
    ? (raw.category as FeedbackCategory)
    : '불편사항';
  const cleanTitle = sanitizeInline(String(raw.title ?? ''), 150);
  const cleanDescription = sanitizeInline(String(raw.description ?? ''), 5000);
  const cleanAuthor = sanitizeInline(String(raw.author ?? ''), 60) || '익명 사용자';

  if (!cleanTitle) {
    throw new Error('피드백 제목을 입력해 주세요.');
  }
  if (!cleanDescription) {
    throw new Error('피드백 상세 내용을 입력해 주세요.');
  }

  const env = raw.envInfo ?? {};
  const userAgent = sanitizeInline(String(env.userAgent ?? '알 수 없음'), 300) || '알 수 없음';
  const resolution = sanitizeInline(String(env.resolution ?? '알 수 없음'), 60) || '알 수 없음';
  const viewport = sanitizeInline(String(env.viewport ?? ''), 60);
  const pwaStandalone = typeof env.pwaStandalone === 'boolean' ? (env.pwaStandalone ? '예 (PWA)' : '아니오 (브라우저)') : '알 수 없음';

  const bodyLines = [
    `## 사용자 피드백 (${category})`,
    '',
    `- **카테고리**: ${category}`,
    `- **작성자**: ${cleanAuthor}`,
    '',
    '### 상세 내용',
    '',
    cleanDescription,
    '',
    '### 실행 환경 정보',
    '',
    `- **User-Agent**: \`${userAgent.replace(/`/g, "'")}\``,
    `- **화면 해상도**: ${resolution}${viewport ? ` (뷰포트: ${viewport})` : ''}`,
    `- **PWA Standalone**: ${pwaStandalone}`,
  ];

  return {
    title: `[${category}] ${cleanTitle}`,
    body: bodyLines.join('\n'),
    labels: resolveIssueLabels(category),
  };
}

function parseRequestBody(rawBody: unknown): FeedbackRequestBody {
  if (typeof rawBody === 'string') {
    return JSON.parse(rawBody) as FeedbackRequestBody;
  }
  if (rawBody && typeof rawBody === 'object') {
    return rawBody as FeedbackRequestBody;
  }
  return {};
}

export default async function handler(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader?.('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const token = typeof process !== 'undefined' ? process?.env?.GITHUB_FEEDBACK_TOKEN?.trim() : undefined;
  if (!token) {
    res.status(500).json({ error: '서버에 GITHUB_FEEDBACK_TOKEN이 설정되지 않았습니다.' });
    return;
  }

  let issuePayload: { title: string; body: string; labels: string[] };
  try {
    const parsedBody = parseRequestBody(req.body);
    issuePayload = buildIssuePayload(parsedBody);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || '요청 본문이 올바르지 않습니다.' });
    return;
  }

  try {
    const ghRes = await fetch(GITHUB_ISSUES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'EduInk-Studio-Feedback',
      },
      body: JSON.stringify(issuePayload),
    });

    if (!ghRes.ok) {
      const detail = await ghRes.text().catch(() => '');
      res.status(ghRes.status >= 400 && ghRes.status < 600 ? ghRes.status : 502).json({
        error: `GitHub 이슈 등록 실패 (${ghRes.status})`,
        detail: detail.slice(0, 300),
      });
      return;
    }

    const created = (await ghRes.json()) as { number?: number; html_url?: string };
    res.status(201).json({
      ok: true,
      issueNumber: created.number ?? null,
      issueUrl: created.html_url ?? null,
    });
  } catch (err) {
    res.status(502).json({
      error: `GitHub API 통신 중 오류가 발생했습니다: ${(err as Error).message || '네트워크 오류'}`,
    });
  }
}
