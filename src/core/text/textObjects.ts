/**
 * 페이지 앵커 기반 독립형 텍스트 객체 데이터 모델 및 헬퍼
 * - PDF 페이지(또는 일반 멀티페이지)의 특정 pageId 로컬 (x, y) 좌표에 소속되어 렌더링된다.
 * - 전체 문서의 절대 좌표나 ProseMirror 텍스트 커서 위치 오류로부터 100% 독립적이다.
 */

export interface NoteTextObject {
  id: string;
  pageId: string;       // 소속된 NotePage 의 id
  x: number;            // 페이지 좌상단 기준 로컬 x (px)
  y: number;            // 페이지 좌상단 기준 로컬 y (px)
  width?: number;       // 텍스트 박스 너비 (기본 자동 또는 min-width: 120px)
  height?: number;      // 텍스트 박스 높이
  text: string;         // 본문 텍스트
  fontSize: number;     // 폰트 크기 (px)
  fontFamily?: string;  // 폰트 패밀리
  color: string;        // 텍스트 색상 (#RRGGBB)
  createdAt: number;
  updatedAt: number;
}

export function newTextObjectId(): string {
  return `txt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

