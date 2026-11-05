# REQUIREMENTS_ERASER.md: 하드웨어 지우개 자동 감지 및 즉각 획 삭제 요구사항 명세서

본 문서는 스테들러 노리스 디지털 점보(STAEDTLER Noris digital Jumbo) 및 S펜 후면 지우개 팁을 활용할 때, UI 지우개 모드 수동 전환 없이 **하드웨어 입력 즉시 감지** 및 **반투명 지연 없는 즉각적 획 삭제(Zero-Latency Eraser)**를 구현하기 위한 기능 요구사항 및 구현 가이드입니다.

---

## 1. 배경 및 문제점 (Current Issues)

1. **지우개 툴 수동 전환의 번거로움**:
   * 스테들러 노리스 점보 등 후면 지우개 팁이 탑재된 스타일러스를 뒤집어 화면에 대더라도, 현재 앱에서는 툴바의 '지우개' 아이콘을 직접 눌러야만 지우개 모드로 동작함.
2. **지연 및 시각적 애니메이션으로 인한 반응성 저하**:
   * 지우개 영역에 닿은 획이 즉시 삭제되지 않고 서서히 반투명해진 후 사라지는 애니메이션(Fade-out) 처리로 인해, 빠른 필기 및 수정 시 반응이 느리고 답답한 사용자 경험을 유발함.

---

## 2. 핵심 요구사항 (Key Requirements)

### REQ-1. 하드웨어 지우개 입력 자동 감지 (Zero-Touch Switching)
* 툴바에서 펜 모드(볼펜, 형광펜 등)가 선택되어 있더라도, **펜 뒤쪽 지우개 팁이 화면에 닿거나 펜 사이드 버튼을 누른 채 터치하면 자동으로 지우개 동작으로 분기**되어야 함.
* 지우개 접촉이 끝나면(`pointerup`) 사용자가 별도 조작을 하지 않아도 원래 선택되어 있던 펜 도구로 자동 복귀해야 함.

### REQ-2. 제로 레이턴시 즉각 삭제 (Instant Erase)
* 지우개 팁의 접촉 반경(Bounding Circle / Bounding Box)과 충돌하는 스트로크(Stroke)는 **반투명 애니메이션이나 트랜지션 없이 즉각 캔버스 및 데이터 모델에서 삭제(Splice)**되어야 함.
* 드로잉 루프(`requestAnimationFrame`) 단위로 충돌 감지 및 배열 필터링을 동기화하여 지우개가 지나간 자리가 실시간으로 깨끗하게 지워져야 함.

---

## 3. 웹 표준 API 감지 메커니즘 (Technical Specification)

웹 브라우저 및 안드로이드 WebView의 W3C Pointer Events 규격에 따라 스타일러스 지우개는 다음 이벤트 속성으로 감지합니다.

### 3.1 Pointer Event 필터 조건

| 하드웨어 동작 | `e.pointerType` | `e.button` / `e.buttons` | 판정 로직 |
| :--- | :--- | :--- | :--- |
| **일반 펜촉 쓰기** | `'pen'` | `buttons === 1` | 기본 드로잉 |
| **스테들러 후면 지우개 접촉** | `'eraser'` 또는 `'pen'` | `buttons === 32` 또는 `pointerType === 'eraser'` | **즉각 지우개 동작** |
| **S펜 측면 버튼 누른 채 접촉** | `'pen'` | `buttons === 2` 또는 `buttons === 32` | **즉각 지우개 동작** |

```typescript
/**
 * 현재 입력 포인터가 하드웨어 지우개인지 판별하는 헬퍼 함수
 */
export function isEraserPointer(e: PointerEvent): boolean {
  // 1. 디바이스 자체가 포인터 타입을 eraser로 보고하는 경우 (Samsung/Wacom 드라이버)
  if (e.pointerType === 'eraser') return true;

  // 2. pointerType이 pen이면서 지우개 플래그(buttons === 32: W3C 지우개 비트마스크)가 활성화된 경우
  if (e.pointerType === 'pen' && (e.buttons & 32) !== 0) return true;

  // 3. S펜 배럴 버튼을 누른 상태 (보조 지우개 제스처 지원 시)
  if (e.pointerType === 'pen' && (e.buttons & 2) !== 0) return true;

  return false;
}
```

---

## 4. 스트로크 충돌 감지 및 즉각 삭제 알고리즘

### 4.1 획 단위 삭제 (Stroke Eraser)
선분과 지우개 원형 반경 간의 최소 거리를 계산하여 임계값(Eraser Radius, 기본 $12\text{px}$) 이내에 들어오면 해당 스트로크를 즉시 데이터 배열에서 제거합니다.

```typescript
// 캔버스 pointermove 루프 내부
function handleEraserMove(x: number, y: number, radius = 12) {
  const radiusSq = radius * radius;
  
  // 충돌하는 스트로크 색출 및 즉시 제거
  const initialCount = strokes.length;
  strokes = strokes.filter(stroke => {
    // 1. AABB(Bounding Box) 1차 판정 (성능 최적화)
    if (x + radius < stroke.bounds.minX || x - radius > stroke.bounds.maxX ||
        y + radius < stroke.bounds.minY || y - radius > stroke.bounds.maxY) {
      return true; // 충돌 없음
    }

    // 2. 점-선분 거리 정밀 판정
    for (let i = 0; i < stroke.points.length - 1; i++) {
      const p1 = stroke.points[i];
      const p2 = stroke.points[i + 1];
      if (distToSegmentSquared({ x, y }, p1, p2) <= radiusSq) {
        return false; // 충돌 즉시 삭제 대상
      }
    }
    return true;
  });

  // 획이 삭제되었으면 rAF를 통해 캔버스 즉시 재렌더링
  if (strokes.length !== initialCount) {
    requestRedraw();
  }
}
```

---

## 5. 검증 체크리스트 (Verification Checklist)

- [ ] **후면 지우개 자동 인식**: 툴바가 '볼펜' 상태일 때 스테들러 점보의 뒤편 지우개로 문지르면 선이 바로 지워지는가?
- [ ] **펜 모드 자동 복원**: 뒤집어 펜촉을 다시 대었을 때 별도 버튼 터치 없이 바로 원래 펜으로 필기되는가?
- [ ] **지연 없는 삭제**: 닿은 즉시 투명도 애니메이션 없이 선이 사라지는가?
- [ ] **S펜 버튼 보조 지우개**: S펜 측면 버튼을 누른 채 화면을 문지를 때도 동일하게 즉각 지우개로 동작하는가?
- [ ] **Undo / Redo 일관성**: 하드웨어 지우개로 지운 획들이 '실행 취소(Ctrl+Z)' 시 정상 복구되는가?





### 6. 추가 요구사항

- 태블릿 사용자가 노트 부분을 확대하는 터치 무브먼트를 하거나 축소시키는 무브먼트로 터치할 때에 그에 맞추어서 노트가 확대되고 축소된다.