export function resolveDeckSwipe(offsetX: number, velocityX: number): 1 | -1 | null {
  if (Math.abs(offsetX) < 70 && Math.abs(velocityX) < 450) return null;
  const direction = Math.abs(offsetX) >= 70 ? offsetX : velocityX;
  return direction < 0 ? 1 : -1;
}
