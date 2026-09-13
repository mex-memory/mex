export interface SpotlightBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 7;

export function boxesForTargets(root: ParentNode, ids: readonly string[]): SpotlightBox[] {
  const boxes: SpotlightBox[] = [];
  for (const id of ids) {
    const node = root.querySelector(`[data-onboarding="${CSS.escape(id)}"]`);
    if (!(node instanceof HTMLElement)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    boxes.push({
      top: rect.top - PAD,
      left: rect.left - PAD,
      width: rect.width + PAD * 2,
      height: rect.height + PAD * 2,
    });
  }
  return boxes;
}

export function unionBoxes(boxes: readonly SpotlightBox[]): SpotlightBox | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return { left, top, width: right - left, height: bottom - top };
}

export function placeCallout(
  anchor: SpotlightBox,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const gap = 16;
  const left = Math.min(anchor.left + anchor.width + gap, Math.max(16, viewport.width - size.width - 16));
  const top = Math.min(Math.max(16, anchor.top), Math.max(16, viewport.height - size.height - 16));
  return { top, left: Math.max(16, left) };
}
