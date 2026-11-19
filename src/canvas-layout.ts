export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
type Box = { id: string; x: number; y: number; width: number; height: number };

export function alignCanvas(boxes: Box[], fixed: Box[], alignment: Alignment, edges: { source: string; target: string }[] = []) {
  const gap = 32;
  const neighbors = new Map<string, Set<string>>();
  for (const { source, target } of edges) {
    const forward = neighbors.get(source) ?? new Set();
    const backward = neighbors.get(target) ?? new Set();
    forward.add(target);
    backward.add(source);
    neighbors.set(source, forward);
    neighbors.set(target, backward);
  }
  const horizontal = alignment === 'left' || alignment === 'right' || alignment === 'center';
  const reverse = alignment === 'right' || alignment === 'bottom';
  const centered = alignment === 'center' || alignment === 'middle';
  const axis = horizontal ? 'x' : 'y';
  const cross = horizontal ? 'y' : 'x';
  const length = horizontal ? 'width' : 'height';
  const breadth = horizontal ? 'height' : 'width';
  const leading = (box: Box) => reverse ? -box[axis] - box[length] : box[axis];
  const ordered = [...boxes].sort((a, b) => leading(a) - leading(b));
  const overlap = (a: Box, b: Box) => a[cross] < b[cross] + b[breadth] && b[cross] < a[cross] + a[breadth];

  function place(start: number, obstacles: Box[]) {
    const placed: { box: Box; offset: number }[] = [];
    for (const box of ordered) {
      // Keep the original order along the movement axis, even for nodes in different lanes.
      let floor = placed.at(-1)?.offset ?? -Infinity;
      for (const previous of placed) {
        const linkedInDirection = neighbors.get(box.id)?.has(previous.box.id) &&
          leading(previous.box) + previous.box[length] <= leading(box);
        if (overlap(box, previous.box) || linkedInDirection) floor = Math.max(floor, previous.offset + previous.box[length] + gap);
      }
      let offset = Math.max(floor, start);
      for (const obstacle of obstacles) {
        if (!overlap(box, obstacle)) continue;
        const near = leading(obstacle);
        const far = near + obstacle[length];
        if (offset + box[length] + gap <= near) break;
        if (leading(box) + box[length] <= near && floor <= near - box[length]) {
          offset = Math.max(floor, Math.min(offset, near - box[length] - gap));
          break;
        }
        floor = Math.max(floor, far + gap);
        offset = Math.max(offset, floor);
      }
      placed.push({ box, offset });
    }
    return placed;
  }

  if (!ordered.length) return new Map<string, { x: number; y: number }>();
  let start = leading(ordered[0]);
  if (centered) {
    const originalEnd = Math.max(...ordered.map(box => leading(box) + box[length]));
    const compactEnd = Math.max(...place(start, []).map(({ box, offset }) => offset + box[length]));
    start += (originalEnd - compactEnd) / 2;
  }

  return new Map(place(start, [...fixed].sort((a, b) => leading(a) - leading(b))).map(({ box, offset }) => [
    box.id, { x: box.x, y: box.y, [axis]: reverse ? -offset - box[length] : offset },
  ]));
}
