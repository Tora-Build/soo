/**
 * Pointer-drag panning for a scrollable region.
 *
 * A cell click and a pan both begin with pointerdown, so movement decides
 * which it was: below the threshold the gesture stays a click, at or beyond
 * it the pointer pans and the click is suppressed.
 */
export const DRAG_THRESHOLD_PX = 5;

export interface DragOrigin {
  pointerX: number;
  pointerY: number;
  scrollLeft: number;
  scrollTop: number;
}

export function isDragGesture(
  origin: DragOrigin,
  pointerX: number,
  pointerY: number,
): boolean {
  const dx = Math.abs(pointerX - origin.pointerX);
  const dy = Math.abs(pointerY - origin.pointerY);
  return Math.max(dx, dy) >= DRAG_THRESHOLD_PX;
}

/** Scroll offsets that keep the grabbed point under the pointer. */
export function dragScrollOffsets(
  origin: DragOrigin,
  pointerX: number,
  pointerY: number,
): { left: number; top: number } {
  return {
    left: origin.scrollLeft - (pointerX - origin.pointerX),
    top: origin.scrollTop - (pointerY - origin.pointerY),
  };
}
