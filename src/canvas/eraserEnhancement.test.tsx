// @vitest-environment jsdom
import { createRef } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InkCanvas } from './InkCanvas';
import { CompositeHistoryManager } from '../core/history/CompositeHistoryManager';
import { StrokeStore, type Stroke } from '../core/strokes/StrokeStore';
import {
  clampNoteZoom,
  computePinchZoom,
  distToSegmentSquared,
  extractClosedLassoPolygon,
  isEraserPointer,
  MAX_NOTE_ZOOM,
  MIN_NOTE_ZOOM,
  touchDistance,
} from '../core/geometry/geometry';
import { lassoCopy } from '../features/lasso';
import { strokeClipboard } from '../store/contextMenuStore';
import { useSettings } from '../store/settingsStore';
import { useSessions } from '../store/sessionStore';
import type { NoteSession } from '../session/NoteSession';

function createSampleStroke(id: string, y: number): Stroke {
  return {
    id,
    tool: 'pencil',
    color: '#000000',
    size: 4,
    points: [
      [10, y, 0.5],
      [50, y, 0.5],
      [100, y, 0.5],
    ],
  };
}

function dispatchPointer(
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: {
    pointerId?: number;
    pointerType: string;
    clientX: number;
    clientY: number;
    button?: number;
    buttons?: number;
    pressure?: number;
  },
) {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(ev, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    button: { value: init.button ?? 0 },
    buttons: { value: init.buttons ?? (type === 'pointerup' ? 0 : 1) },
    pressure: { value: init.pressure ?? 0.5 },
  });
  target.dispatchEvent(ev);
}

describe('하드웨어 지우개 자동 감지 및 즉각 획 삭제 (eraser_enhancement_requirements.md)', () => {
  beforeEach(() => {
    useSettings.setState({
      tool: 'pencil',
      penSize: 4,
      highlighterSize: 18,
      eraserSize: 12,
      mouseDraw: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('§3.1 isEraserPointer: 스테들러 노리스 점보 후면 지우개 및 S펜 측면 버튼을 정확히 판별한다', () => {
    // 1. 일반 펜촉 쓰기 (pointerType: pen, buttons: 1) -> 기본 드로잉
    expect(isEraserPointer({ pointerType: 'pen', buttons: 1, button: 0 })).toBe(false);

    // 2. 스테들러 후면 지우개 접촉 (pointerType: eraser 또는 buttons: 32)
    expect(isEraserPointer({ pointerType: 'eraser', buttons: 1 })).toBe(true);
    expect(isEraserPointer({ pointerType: 'pen', buttons: 32 })).toBe(true);
    expect(isEraserPointer({ pointerType: 'pen', buttons: 33 })).toBe(true); // 비트마스크 결합 케이스
    expect(isEraserPointer({ pointerType: 'pen', buttons: 0, button: 5 })).toBe(true);

    // 3. S펜 측면(배럴) 버튼 누른 채 접촉 (buttons: 2)
    expect(isEraserPointer({ pointerType: 'pen', buttons: 2 })).toBe(true);
    expect(isEraserPointer({ pointerType: 'pen', buttons: 3 })).toBe(true);
    expect(isEraserPointer({ pointerType: 'pen', buttons: 0, button: 2 })).toBe(true);

    // 4. 터치 및 마우스 입력은 하드웨어 지우개가 아님
    expect(isEraserPointer({ pointerType: 'touch', buttons: 1 })).toBe(false);
    expect(isEraserPointer({ pointerType: 'mouse', buttons: 2 })).toBe(false);
  });

  it('§4.1 distToSegmentSquared & StrokeStore.eraseAt: 반경 12px 이내 충돌 획을 즉시 삭제하고 단일 Undo/Redo로 복원한다', () => {
    expect(distToSegmentSquared({ x: 50, y: 5 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(25);

    const history = new CompositeHistoryManager();
    const store = new StrokeStore(history, [
      createSampleStroke('s1', 20),
      createSampleStroke('s2', 60),
      createSampleStroke('s3', 120),
    ]);

    // 1차 접촉: s1(y=20) 지우기 -> pointerup 전에도 즉시 배열에서 삭제됨
    const first = store.eraseAt(50, 25, 12);
    expect(first.removedIds).toEqual(['s1']);
    expect(store.getAll().map((s) => s.id)).toEqual(['s2', 's3']);

    // 동일 제스처 드래그 중 2차 접촉: s2(y=60) 지우기 (mergeCommandId 전달)
    const second = store.eraseAt(50, 55, 12, first.commandId);
    expect(second.removedIds).toEqual(['s2']);
    expect(store.getAll().map((s) => s.id)).toEqual(['s3']);

    // 단일 드래그 제스처이므로 Undo 스택 크기는 1이어야 하며, 1회 실행 취소(Ctrl+Z)로 s1, s2 모두 원래 순서로 복구됨
    expect(history.size.undo).toBe(1);
    history.undo();
    expect(store.getAll().map((s) => s.id)).toEqual(['s1', 's2', 's3']);

    // Redo 실행 시 다시 s1, s2 가 삭제됨
    history.redo();
    expect(store.getAll().map((s) => s.id)).toEqual(['s3']);
  });

  it('§5 검증 체크리스트: 볼펜 모드에서 후면 지우개/S펜 버튼 즉각 삭제 후 펜촉으로 대면 볼펜 필기로 자동 복귀한다', () => {
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history, [
      createSampleStroke('stroke-a', 30),
      createSampleStroke('stroke-b', 80),
    ]);

    const noteId = 'note-eraser-test';
    useSessions.getState().patch(noteId, {
      loaded: true,
      readOnly: false,
      lassoIds: [],
      moveMode: false,
    });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);

    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 1000,
      width: 800,
      height: 1000,
      toJSON: () => ({}),
    });
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 1000,
      width: 800,
      height: 1000,
      toJSON: () => ({}),
    });

    const mockSession = {
      id: noteId,
      history,
      strokes,
      pageEl,
      get ui() {
        return useSessions.getState().sessions[noteId]!;
      },
      patch(p: Parameters<ReturnType<typeof useSessions.getState>['patch']>[1]) {
        useSessions.getState().patch(noteId, p);
      },
      undo() {
        history.undo();
      },
      redo() {
        history.redo();
      },
    } as unknown as NoteSession;

    const viewportRef = createRef<HTMLDivElement>();
    viewportRef.current = viewport;

    render(<InkCanvas session={mockSession} viewportRef={viewportRef} active={true} />);

    // 1. 툴바가 'pencil'(볼펜) 상태임을 확인
    expect(useSettings.getState().tool).toBe('pencil');
    expect(strokes.getAll().map((s) => s.id)).toEqual(['stroke-a', 'stroke-b']);

    // 2. 스테들러 점보 후면 지우개(pointerType: 'pen', buttons: 32)로 stroke-a 위를 터치
    // pointerup 이전(pointerdown 시점)에 반투명 대기 없이 즉시 삭제되어야 함 (REQ-2)
    act(() => {
      dispatchPointer(viewport, 'pointerdown', {
        pointerId: 10,
        pointerType: 'pen',
        buttons: 32,
        clientX: 40,
        clientY: 30,
      });
    });
    expect(strokes.getAll().map((s) => s.id)).toEqual(['stroke-b']);

    // 3. 계속 문질러서 stroke-b(y=80) 통과 시 pointermove 즉시 stroke-b 삭제
    act(() => {
      dispatchPointer(viewport, 'pointermove', {
        pointerId: 10,
        pointerType: 'pen',
        buttons: 32,
        clientX: 40,
        clientY: 80,
      });
    });
    expect(strokes.getAll()).toHaveLength(0);

    // 지우개 떼기 (pointerup)
    act(() => {
      dispatchPointer(viewport, 'pointerup', {
        pointerId: 10,
        pointerType: 'pen',
        buttons: 0,
        clientX: 40,
        clientY: 80,
      });
    });

    // 4. Undo(실행 취소) 시 하드웨어 지우개로 지운 두 획이 한 번에 복원됨
    act(() => {
      mockSession.undo();
    });
    expect(strokes.getAll().map((s) => s.id)).toEqual(['stroke-a', 'stroke-b']);

    // 5. S펜 측면 버튼(buttons: 2)을 누른 채 문지를 때도 즉각 지우개로 동작
    act(() => {
      dispatchPointer(viewport, 'pointerdown', {
        pointerId: 11,
        pointerType: 'pen',
        buttons: 2,
        clientX: 50,
        clientY: 30,
      });
      dispatchPointer(viewport, 'pointerup', {
        pointerId: 11,
        pointerType: 'pen',
        buttons: 0,
        clientX: 50,
        clientY: 30,
      });
    });
    expect(strokes.getAll().map((s) => s.id)).toEqual(['stroke-b']);

    // 6. 펜 모드 자동 복원: 별도 UI 조작 없이 다시 펜촉(buttons: 1)으로 쓰면 원래 'pencil' 도구로 즉시 필기됨
    expect(useSettings.getState().tool).toBe('pencil');
    act(() => {
      dispatchPointer(viewport, 'pointerdown', {
        pointerId: 12,
        pointerType: 'pen',
        buttons: 1,
        clientX: 10,
        clientY: 200,
      });
      dispatchPointer(viewport, 'pointermove', {
        pointerId: 12,
        pointerType: 'pen',
        buttons: 1,
        clientX: 60,
        clientY: 200,
      });
      dispatchPointer(viewport, 'pointerup', {
        pointerId: 12,
        pointerType: 'pen',
        buttons: 0,
        clientX: 60,
        clientY: 200,
      });
    });
    expect(strokes.getAll()).toHaveLength(2);
    expect(strokes.getAll()[1].tool).toBe('pencil');

    // 7. 노트 확대(zoom = 2.0) 상태에서도 지우개/펜 좌표 변환이 정확하게 동작하는지 검증
    act(() => {
      mockSession.patch({ zoom: 2 });
    });
    // stroke-b는 y=80 에 위치하므로 zoom=2 일 때 화면 좌표 clientY = 160, clientX = 100(=50*2)
    act(() => {
      dispatchPointer(viewport, 'pointerdown', {
        pointerId: 13,
        pointerType: 'eraser',
        buttons: 32,
        clientX: 100,
        clientY: 160,
      });
      dispatchPointer(viewport, 'pointerup', {
        pointerId: 13,
        pointerType: 'eraser',
        buttons: 0,
        clientX: 100,
        clientY: 160,
      });
    });
    expect(strokes.getAll()).toHaveLength(1);

    document.body.removeChild(viewport);
  });

  it('§6 추가 요구사항: 태블릿 사용자의 두 손가락 확대/축소(Pinch-to-Zoom) 터치 무브먼트에 맞추어 노트가 확대·축소된다', () => {
    // 두 터치 지점 거리 계산
    expect(touchDistance({ x: 100, y: 100 }, { x: 200, y: 100 })).toBe(100);

    // 1. 확대 터치 무브먼트 (두 손가락 간격 100px -> 180px): 1.0x -> 1.8x
    const zoomedIn = computePinchZoom({
      startDistance: 100,
      currentDistance: 180,
      startZoom: 1,
    });
    expect(zoomedIn).toBeCloseTo(1.8);

    // 2. 이어서 축소 터치 무브먼트 (두 손가락 간격 200px -> 100px, 시작 배율 1.8x): 1.8x -> 0.9x
    const zoomedOut = computePinchZoom({
      startDistance: 200,
      currentDistance: 100,
      startZoom: zoomedIn,
    });
    expect(zoomedOut).toBeCloseTo(0.9);

    // 3. 최소/최대 배율 클램핑 (0.5x ~ 3.0x)
    expect(
      computePinchZoom({
        startDistance: 100,
        currentDistance: 500,
        startZoom: 1,
      }),
    ).toBe(MAX_NOTE_ZOOM);
    expect(
      computePinchZoom({
        startDistance: 300,
        currentDistance: 50,
        startZoom: 1,
      }),
    ).toBe(MIN_NOTE_ZOOM);
    expect(clampNoteZoom(Number.NaN)).toBe(1);
  });

  it('올가미(Lasso): closed curve 가 아닐 때 S펜을 떼면 사라지고, closed curve 일 때만 내부 손글씨가 드래그 상태가 되며 복사 클릭 시 메뉴/드래그 상태가 해제된다', () => {
    const history = new CompositeHistoryManager();
    const strokes = new StrokeStore(history, [
      createSampleStroke('stroke-inside', 30),
      createSampleStroke('stroke-outside', 200),
    ]);

    const noteId = 'note-lasso-test';
    useSessions.getState().patch(noteId, {
      loaded: true,
      readOnly: false,
      lassoIds: [],
      moveMode: false,
      zoom: 1,
    });

    const viewport = document.createElement('div');
    const pageEl = document.createElement('div');
    viewport.appendChild(pageEl);
    document.body.appendChild(viewport);

    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 1000,
      width: 800,
      height: 1000,
      toJSON: () => ({}),
    });
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 1000,
      width: 800,
      height: 1000,
      toJSON: () => ({}),
    });

    const mockSession = {
      id: noteId,
      history,
      strokes,
      pageEl,
      get ui() {
        return useSessions.getState().sessions[noteId]!;
      },
      patch(p: Parameters<ReturnType<typeof useSessions.getState>['patch']>[1]) {
        useSessions.getState().patch(noteId, p);
      },
    } as unknown as NoteSession;

    const viewportRef = createRef<HTMLDivElement>();
    viewportRef.current = viewport;

    useSettings.setState({ tool: 'lasso' });
    render(<InkCanvas session={mockSession} viewportRef={viewportRef} active={true} />);

    // 1. 닫히지 않은 곡선(Open curve)을 그리고 S펜을 화면에서 뗀 경우 -> 올가미가 사라지고 아무것도 선택되지 않음
    const openCurve = [
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 60 },
    ];
    expect(extractClosedLassoPolygon(openCurve)).toBeNull();

    act(() => {
      dispatchPointer(viewport, 'pointerdown', { pointerId: 20, pointerType: 'pen', buttons: 1, clientX: 0, clientY: 0 });
      dispatchPointer(viewport, 'pointermove', { pointerId: 20, pointerType: 'pen', buttons: 1, clientX: 120, clientY: 0 });
      dispatchPointer(viewport, 'pointermove', { pointerId: 20, pointerType: 'pen', buttons: 1, clientX: 120, clientY: 60 });
      dispatchPointer(viewport, 'pointerup', { pointerId: 20, pointerType: 'pen', buttons: 0, clientX: 120, clientY: 60 });
    });
    expect(mockSession.ui.lassoIds).toEqual([]);
    expect(mockSession.ui.moveMode).toBe(false);

    // 2. 닫힌 곡선(Closed curve)을 그려서 stroke-inside(y=30)를 감싼 경우 -> 내부 손글씨가 드래그(선택/이동) 상태가 됨
    act(() => {
      dispatchPointer(viewport, 'pointerdown', { pointerId: 21, pointerType: 'pen', buttons: 1, clientX: 0, clientY: 0 });
      dispatchPointer(viewport, 'pointermove', { pointerId: 21, pointerType: 'pen', buttons: 1, clientX: 120, clientY: 0 });
      dispatchPointer(viewport, 'pointermove', { pointerId: 21, pointerType: 'pen', buttons: 1, clientX: 120, clientY: 60 });
      dispatchPointer(viewport, 'pointermove', { pointerId: 21, pointerType: 'pen', buttons: 1, clientX: 0, clientY: 60 });
      dispatchPointer(viewport, 'pointermove', { pointerId: 21, pointerType: 'pen', buttons: 1, clientX: 0, clientY: 5 });
      dispatchPointer(viewport, 'pointerup', { pointerId: 21, pointerType: 'pen', buttons: 0, clientX: 0, clientY: 5 });
    });
    expect(mockSession.ui.lassoIds).toEqual(['stroke-inside']);
    expect(mockSession.ui.moveMode).toBe(true);

    // 3. 복사(lassoCopy) 버튼 클릭 시 -> 클립보드에 복사되면서 동시에 메뉴 및 드래그(선택) 상태가 즉시 해제됨
    act(() => {
      lassoCopy(mockSession);
    });
    expect(strokeClipboard.strokes).toHaveLength(1);
    expect(strokeClipboard.strokes[0].id).toBe('stroke-inside');
    expect(mockSession.ui.lassoIds).toEqual([]);
    expect(mockSession.ui.moveMode).toBe(false);

    document.body.removeChild(viewport);
  });
});
