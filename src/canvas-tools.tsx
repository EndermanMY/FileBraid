import { useRef, type PointerEvent } from 'react';
import { getBezierPath, Position, useReactFlow, useStore, type Edge, type Node } from '@xyflow/react';

export type CanvasBox = { left: number; top: number; width: number; height: number };
export type MapOptions = { color: boolean; edges: boolean; groups: boolean };

const nodeColors: Record<string, string> = {
  'kind-source': '#467d82', 'kind-target': '#a87f44', 'kind-copy': '#a97855',
  'kind-tree': '#547b9b', 'kind-outputtree': '#547b9b', 'kind-algorithm': '#7474a1',
};

export function GraphMap({ nodes, edges, groups, options }: {
  nodes: Node[]; edges: Edge[]; groups: CanvasBox[]; options: MapOptions;
}) {
  const { setCenter, zoomIn, zoomOut, getInternalNode } = useReactFlow();
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  const [x, y, zoom] = useStore(state => state.transform);
  const dragBounds = useRef<CanvasBox>(null);
  const view = { left: -x / zoom, top: -y / zoom, width: width / zoom, height: height / zoom };
  const boxes = new Map(nodes.map(node => [node.id, {
    left: node.position.x, top: node.position.y,
    width: node.measured?.width ?? node.width ?? 240,
    height: node.measured?.height ?? node.height ?? 100,
  }]));
  const all = [view, ...boxes.values(), ...(options.groups ? groups : [])];
  const left = Math.min(...all.map(box => box.left)) - 32;
  const top = Math.min(...all.map(box => box.top)) - 32;
  const right = Math.max(...all.map(box => box.left + box.width)) + 32;
  const bottom = Math.max(...all.map(box => box.top + box.height)) + 32;
  const bounds = dragBounds.current ?? { left, top, width: right - left, height: bottom - top };

  function move(event: PointerEvent<SVGSVGElement>) {
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return;
    const location = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    void setCenter(location.x, location.y, { zoom });
  }

  return <svg className="react-flow__minimap canvas-map-svg" role="img" aria-label="画布小地图"
    viewBox={`${bounds.left} ${bounds.top} ${bounds.width} ${bounds.height}`}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragBounds.current = bounds;
      move(event);
    }}
    onPointerMove={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event);
    }}
    onLostPointerCapture={() => { dragBounds.current = null; }}
    onWheel={event => { void (event.deltaY > 0 ? zoomOut() : zoomIn()); }}>
    <rect x={bounds.left} y={bounds.top} width={bounds.width} height={bounds.height} fill="#252525" />
    <rect x={view.left} y={view.top} width={view.width} height={view.height} fill="#414141" />
    {options.groups && groups.map((box, index) => <rect key={index} x={box.left} y={box.top}
      width={box.width} height={box.height} fill="#62768533" stroke="#6e8999" vectorEffect="non-scaling-stroke" />)}
    {options.edges && edges.map(edge => {
      const from = boxes.get(edge.source);
      const to = boxes.get(edge.target);
      if (!from || !to) return null;
      const source = getInternalNode(edge.source)?.internals.handleBounds?.source?.find(handle => handle.id === edge.sourceHandle);
      const target = getInternalNode(edge.target)?.internals.handleBounds?.target?.find(handle => handle.id === edge.targetHandle);
      const [path] = getBezierPath({
        sourceX: from.left + (source ? source.x + source.width : from.width),
        sourceY: from.top + (source ? source.y + source.height / 2 : from.height / 2),
        sourcePosition: source?.position ?? Position.Right,
        targetX: to.left + (target?.x ?? 0),
        targetY: to.top + (target ? target.y + target.height / 2 : to.height / 2),
        targetPosition: target?.position ?? Position.Left,
      });
      return <path key={edge.id} className="canvas-map-edge" d={path} fill="none" stroke="#969da1" opacity=".55"
        vectorEffect="non-scaling-stroke" />;
    })}
    {nodes.map(node => {
      const box = boxes.get(node.id)!;
      return <rect key={node.id} x={box.left} y={box.top} width={box.width} height={box.height}
        fill={options.color ? nodeColors[(node.className ?? '').split(' ')[0]] ?? '#4380a3' : '#4380a3'}
        opacity={node.selected ? 1 : .85} />;
    })}
    <rect x={view.left} y={view.top} width={view.width} height={view.height}
      fill="none" stroke="#f4f4f4" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
  </svg>;
}

const icons = {
  select: <path d="m5 4 13 7-6 1-3 5z" />,
  hand: <path d="M8 12V5a1.2 1.2 0 0 1 2.4 0v5-7a1.2 1.2 0 0 1 2.4 0v7-5a1.2 1.2 0 0 1 2.4 0v6-3a1.2 1.2 0 0 1 2.4 0v6c0 4-2 6-5 6h-2c-2 0-3.5-1.4-5-4l-1.5-2.6c-.8-1.7.9-2.4 2-1.3L8 14" />,
  fit: <><path d="M8 4H4v4m8-4h4v4M4 12v4h4m4 0h4v-4" /><circle cx="10" cy="10" r="1.5" /></>,
  map: <path d="m3 6 5-2 5 2 5-2v12l-5 2-5-2-5 2zM8 4v12m5-10v12" />,
  link: <path d="M8 13l4-4m-5 1L5 12a3 3 0 0 0 4 4l2-2m-1-7 2-2a3 3 0 0 1 4 4l-2 2" />,
  unlink: <path d="M4 4l12 12m-9-6-2 2a3 3 0 0 0 4 4l2-2m-1-7 2-2a3 3 0 0 1 4 4l-2 2" />,
  settings: <><path d="M3 6h3m4 0h7M3 14h8m4 0h2" /><circle cx="8" cy="6" r="2" /><circle cx="13" cy="14" r="2" /></>,
  close: <path d="m5 5 10 10m0-10L5 15" />,
  chevron: <path d="m5 8 5 5 5-5" />,
};
export function CanvasIcon({ name }: { name: keyof typeof icons }) {
  return <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor"
    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>;
}
