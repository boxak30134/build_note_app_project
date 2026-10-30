import type { AABB } from '../../core/geometry/geometry';

export interface BubbleTurn {
  question: string;
  provider: string;
  at: number;
}

export type AnnotationAnchor =
  | { type: 'text'; quote: string }
  | { type: 'strokes'; strokeIds: string[]; fallbackBox: AABB }
  | { type: 'point'; x: number; y: number };

export interface Annotation {
  id: string;
  anchor: AnnotationAnchor;
  /** Editable Markdown 본문 (사용자 메모 + AI 답변), 최대 2,500자 */
  body: string;
  turns: BubbleTurn[];
  createdAt: number;
}
