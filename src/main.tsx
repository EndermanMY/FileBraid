import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { CanvasIcon, GraphMap, type MapOptions } from './canvas-tools';
import { alignCanvas, type Alignment } from './canvas-layout';
import {
  addEdge, Background, Handle, NodeResizeControl, Position, ReactFlow, ViewportPortal, reconnectEdge, SelectionMode, useEdgesState, useNodeConnections, useNodesState, useUpdateNodeInternals,
  type Connection, type Edge, type HandleType, type Node, type NodeProps, type ReactFlowInstance, type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import { transferSpeedAxis } from './speed-axis';
import { addSpeedSample, continuousSpeed, speedIntervals, stableSpeedEnd, type SpeedBucket } from './copy-speed';
import { displayPath } from './path-display';
import { fileWork } from './transfer-progress';

const algorithms = {
  crc32: 'CRC32 校验', blake3: 'BLAKE3 校验', md5: 'MD5 校验', sha1: 'SHA-1 校验', sha256: 'SHA-256 校验', xxh3: 'xxHash3-64 校验',
};
const labels = {
  source: '源目录', media: '拍摄介质', target: '目标目录', tree: '来源目录树', outputtree: '目标目录树', copy: '复制',
  camera: 'Sony 素材分类', filter: '按扩展名筛选', merge: '合并文件', subtract: '排除文件',
  directory: '目录模板', standardcopy: '标准复制策略', fastcopy: '流复制策略', ...algorithms,
};
type Kind = keyof typeof labels;
const nodeGroups: { title: string; kinds: Kind[] }[] = [
  { title: '输入与输出', kinds: ['source', 'media', 'tree', 'outputtree', 'target'] },
  { title: '整理与筛选', kinds: ['camera', 'filter', 'merge', 'subtract'] },
  { title: '文件操作', kinds: ['copy'] },
  { title: '复制策略', kinds: ['standardcopy', 'fastcopy'] },
  { title: '校验', kinds: Object.keys(algorithms) as Kind[] },
];
const nodeDragType = 'application/x-filebraid-node';
const officialWorkflowName = '双目标工作流';
const sonyWorkflowName = 'Sony 双目标工作流';
const isFileSource = (kind: Kind) => kind === 'source' || kind === 'media';
const isAlgorithm = (kind?: Kind) => kind !== undefined && Object.hasOwn(algorithms, kind);
type PortId = 'files' | 'verify' | 'transfer' | 'exclude' | 'operation';
const port = (kind?: Kind) => kind === 'copy' ? 'operation' :
  kind === 'standardcopy' || kind === 'fastcopy' ? 'transfer' : isAlgorithm(kind) ? 'verify' : 'files';
type Pin = { nodeId: string; direction: HandleType; handle: string };
const sonyOutputs = [
  { id: 'out', label: '全部文件', detail: '保留输入的全部文件及相对路径，用于整卡归档' },
  { id: 'sony:photos', label: '照片文件', detail: 'DCIM 中的 RAW、JPEG 和 HEIF 照片' },
  { id: 'sony:videos', label: '视频文件', detail: '原片及按名称匹配的片段 XML 和缩略图' },
  { id: 'sony:proxies', label: '代理文件', detail: 'SUB 中的代理视频和对应的片段 XML' },
  { id: 'sony:management', label: '卡管理文件', detail: '卡索引、数据库和未配对的素材附属文件' },
  { id: 'sony:luts', label: 'LUT 文件', detail: 'Sony 卡目录内的 .cube LUT' },
  { id: 'sony:other', label: '其他文件', detail: '未识别文件，包括以 ._ 开头的 macOS 辅助文件' },
];
const portLabels = { files: '文件', verify: '校验策略', transfer: '复制策略', exclude: '排除文件', operation: '文件' };
function acceptsPort(kind: Kind, input: PortId, from: Kind) {
  if (kind === 'target') return input === 'operation';
  if (kind === 'copy') return input === 'files' || input === 'transfer' || input === 'verify';
  if (kind === 'tree') return input === 'files' && isFileSource(from);
  if (input === 'exclude') return kind === 'subtract';
  return input === 'files' && ['camera', 'filter', 'merge', 'subtract', 'outputtree'].includes(kind);
}
function filePort(handle: string): PortId | undefined {
  return handle.startsWith('folder:') || handle.startsWith('disk:') ? 'files' :
    Object.hasOwn(portLabels, handle) ? handle as PortId : undefined;
}
function portLabel(kind: Kind | undefined, direction: HandleType, handle: string) {
  if (kind === 'camera' && direction === 'source') {
    return sonyOutputs.find(output => output.id === handle)?.label ?? portLabels.files;
  }
  if (kind === 'copy') {
    if (direction === 'source') return '输出文件';
    if (handle === 'files') return '输入文件';
  }
  const type = direction === 'source' ? port(kind) : filePort(handle) ?? 'files';
  return portLabels[type];
}
type OutputFolder = { id: string; name: string; parent?: string };
const maxOutputFolders = 100;

function directoryChain(path: string): OutputFolder[] {
  const parts = path.split('/');
  if (parts.length > maxOutputFolders) {
    throw new Error('旧「目录模板」超过目录树支持的 100 层，请在旧版缩短层级后再打开。');
  }
  return parts.map((name, index) => ({
    id: `level-${index + 1}`,
    name,
    parent: index > 0 ? `level-${index}` : undefined,
  }));
}
function outputFolders(value: string): OutputFolder[] {
  if (!value) return [];
  try {
    const folders: unknown = JSON.parse(value);
    if (!Array.isArray(folders) || folders.length > maxOutputFolders) return [];
    const known = new Set<string>();
    for (const folder of folders) {
      if (!folder || typeof folder.id !== 'string' || !folder.id || known.has(folder.id) ||
        typeof folder.name !== 'string' || (folder.parent != null && !known.has(folder.parent))) return [];
      known.add(folder.id);
    }
    return folders;
  } catch { return []; }
}
type WorkflowNode = { id: string; kind: Kind; value: string; x: number; y: number; width?: number; height?: number; group?: string; groupName?: string };
type Workflow = { version: 4; nodes: WorkflowNode[]; edges: Edge[] };
const workflowLimits = { 1: [100, 200], 2: [101, 300], 3: [101, 300], 4: [202, 401] } as const;
type LibraryWorkflow = { id: string; name: string; created: string };
function copyStrategies(nodes: WorkflowNode[], edges: Edge[]) {
  const strategyNodes = new Set(nodes.filter(node => port(node.kind) === 'transfer').map(node => node.id));
  return new Set(edges.filter(edge => strategyNodes.has(edge.source) &&
    (edge.sourceHandle ?? 'out') === 'out' && (edge.targetHandle ?? 'transfer') === 'transfer').map(edge => edge.target));
}
type FlowNode = Node<{ kind: Kind; value: string; group?: string; groupName?: string }, 'blueprint'>;
type FolderEntry = { name: string; directory: boolean };
type ShootingMedia = {
  id: string; root: string; type: 'sd' | 'cfa' | 'shooting-storage';
  deviceModel: string | null; deviceSerial: string | null; mediaModel: string | null; mediaSerial: string | null;
};
const mediaTypes = { sd: 'SD 卡', cfa: 'CFexpress Type A', 'shooting-storage': '拍摄存储' };
const mediaSelection = ({ id, root }: ShootingMedia) => JSON.stringify({ id, root });
type SonySource = { kind: 'media' | 'source'; value: string; output: string };

function mediaRoot(value: string): string {
  try {
    const selection = JSON.parse(value);
    return typeof selection?.root === 'string' ? selection.root : '';
  } catch { return ''; }
}
function treeInputs(nodes: FlowNode[], edges: Edge[]) {
  const sources = new Map(nodes.filter(node => isFileSource(node.data.kind))
    .map(node => [node.id, node.data.kind === 'media' ? mediaRoot(node.data.value) : node.data.value]));
  return new Map(edges.flatMap(edge => sources.has(edge.source) && (edge.targetHandle ?? 'files') === 'files'
    ? [[edge.target, sources.get(edge.source)!] as const] : []));
}
function sonyInputs(nodes: FlowNode[], edges: Edge[]) {
  const byId = new Map(nodes.map(node => [node.id, node.data]));
  const inputs = new Map(edges.filter(edge => (edge.targetHandle ?? 'files') === 'files').map(edge => [edge.target, edge]));
  const sources = new Map<string, SonySource | null>();
  for (const node of nodes) {
    if (node.data.kind !== 'camera') continue;
    const edge = inputs.get(node.id);
    if (!edge) continue;
    const upstream = byId.get(edge.source);
    const output = edge.sourceHandle ?? 'out';
    const root = upstream?.kind === 'tree' ? byId.get(inputs.get(edge.source)?.source ?? '') : upstream;
    if (root?.kind === 'source' || root?.kind === 'media') {
      sources.set(node.id, { kind: root.kind, value: root.value, output });
    } else if (upstream?.kind === 'tree' && !root) {
      sources.set(node.id, { kind: 'source', value: upstream.value, output });
    } else {
      sources.set(node.id, null);
    }
  }
  return sources;
}
function treeDestinations(nodes: FlowNode[], edges: Edge[]) {
  const targets = new Map(nodes.filter(node => node.data.kind === 'target').map(node => [node.id, node.data.value]));
  const copies = new Set(nodes.filter(node => node.data.kind === 'copy').map(node => node.id));
  const roots = new Map<string, string>();
  for (const node of nodes) {
    if (node.data.kind !== 'outputtree') continue;
    const outgoing = edges.filter(edge => edge.source === node.id);
    if (outgoing.length !== 1 || !copies.has(outgoing[0].target)) continue;
    const operation = edges.filter(edge => edge.source === outgoing[0].target);
    if (operation.length !== 1) continue;
    const target = targets.get(operation[0].target);
    if (target !== undefined) roots.set(node.id, target);
  }
  return roots;
}
type CopyMode = 'auto' | 'parallel' | 'batch';
type CopySettings = { buffer_mib: number; block_mib: number; queue_depth: number; small_file_kib: number; mode: CopyMode; limit_mib_s: number; low_io: boolean };
const copyDefaults: CopySettings = { buffer_mib: 32, block_mib: 2, queue_depth: 8, small_file_kib: 128, mode: 'auto', limit_mib_s: 0, low_io: false };
type VerifyTiming = 'per_file' | 'after_copy';
const verifyTimingLabels = { per_file: '边复制边校验', after_copy: '复制完再校验' };
type PlanRow = { source: string; destination: string; bytes: number; category: string; verified_by: string[]; verify_timing: VerifyTiming | null; existing: boolean; target: string; copy_settings: CopySettings | null; copy_mode: Exclude<CopyMode, 'auto'> | null };
type Plan = { id: string; rows: PlanRow[]; excluded: string[]; fingerprint: string };
type Checksums = Record<string, string>;
type Outcome = { destination: string; target: string; status: 'verified' | 'reused' | 'copied' | 'failed' | 'cancelled';
  error: string | null; retried: boolean; checksums: Checksums; source_checksums?: Checksums; target_checksums?: Checksums };
type CopyProgress = { kind: 'progress'; destination: string; target: string; phase: 'source' | 'copy' | 'flush' | 'await_verify' | 'verify'; bytes: number; bytes_per_second: number; source_checksums?: Checksums };
const phases = { source: '读取来源', copy: '复制中', flush: '写入磁盘', await_verify: '已写入，待校验', verify: '校验目标' };
type TimedProgress = CopyProgress & { time: number };
type CopySpeedByTarget = Map<string, Map<number, SpeedBucket>>;
type Reading = { rate: number; time: number; destination: string; phase: CopyProgress['phase'] };
type TargetReadings = Partial<Record<'write' | 'read', Reading>>;
type QueueTask = {
  plan: Plan; workflow: Workflow; status: 'waiting' | 'running' | 'finished' | 'failed' | 'cancelled';
  name?: string;
  outcomes: Map<string, Outcome>; progress: Map<string, TimedProgress>; samples: CopySpeedByTarget; readSamples: CopySpeedByTarget;
  rates: Map<string, TargetReadings>;
  awaitingVerification: ReadonlySet<string>;
  sourceHashes: ReadonlyMap<string, Checksums>;
  control?: 'paused' | 'cancelling';
  message?: string; report?: boolean; verifyOnly?: boolean;
  speedStart?: number; speedElapsed?: number;
};
function waitingTask(plan: Plan, workflow: Workflow, name?: string): QueueTask {
  return { plan, workflow, name, status: 'waiting', outcomes: new Map(), progress: new Map(),
    samples: new Map(), readSamples: new Map(), rates: new Map(), awaitingVerification: new Set(), sourceHashes: new Map() };
}

function speedKind(phase: CopyProgress['phase']) {
  if (phase === 'copy') return 'write';
  if (phase === 'source' || phase === 'verify') return 'read';
}

const queueLabels = { waiting: '待执行', running: '运行中', finished: '已完成', failed: '未完成', cancelled: '已停止' };
function byteSize(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = bytes >= 1 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
const outcomeLabels = {
  verified: '校验通过', reused: '已跳过', copied: '复制完成，未校验', failed: '失败', cancelled: '已中止',
};
const skippedDescription = '目标已有同内容的文件，本次跳过写入。';
const statusIcons = {
  verified: '', reused: '', copied: '', failed: '', cancelled: '', pending: '',
  await_verify: '', copy: '', flush: '', source: '', verify: '',
};

function FileStatus({ state, status, percent, error }: {
  state: keyof typeof statusIcons; status: string; percent?: number; error?: string | null;
}) {
  const detail = [status + (percent === undefined ? '' : ` · ${percent}%`),
    error ?? (state === 'reused' ? skippedDescription : undefined)].filter(Boolean).join('\n');
  return <td className="file-status" title={detail}>
    {percent !== undefined ? <span role="progressbar" aria-label={status} aria-valuenow={percent} data-state={state}>
      <svg viewBox="0 0 16 16" aria-hidden="true" className="file-progress-ring">
        <circle className="file-progress-track" cx="8" cy="8" r="6" />
        <circle cx="8" cy="8" r="6" pathLength="100" strokeDasharray={`${percent} 100`} transform="rotate(-90 8 8)" />
      </svg>
    </span> : <span role="img" aria-label={status} data-state={state} data-icon={statusIcons[state]}>
      {(state === 'verified' || state === 'copied') && <svg viewBox="0 0 16 16" aria-hidden="true" className="file-check-icon">
        {state === 'verified' ? <path d="M1.3 8.5l3.1 3.1L11 5m-5.7 3.5 3.1 3.1L15 5" /> : <path d="m2.7 8.4 3.5 3.5 7.1-7.1" />}
      </svg>}
      {state === 'failed' && <svg viewBox="0 0 16 16" aria-hidden="true" className="file-error-icon">
        <path d="M7.3 2.6a.8.8 0 0 1 1.4 0l6.2 10.5a.8.8 0 0 1-.7 1.2H1.8a.8.8 0 0 1-.7-1.2Z" />
        <path className="file-error-mark" d="M8 6v3.4m0 2.2h.01" />
      </svg>}
      {(state === 'cancelled' || state === 'await_verify') && <svg viewBox="0 0 16 16" aria-hidden="true" className="file-timing-icon">
        <circle cx="8" cy="8" r="5.7" />
        {state === 'cancelled' ? <path d="m4 12 8-8" /> : <path d="M8 4.9v3.3h3.1" />}
      </svg>}
      {state === 'pending' && <svg viewBox="0 0 16 16" aria-hidden="true" className="file-pending-icon">
        <rect x="5.5" y="5.5" width="5" height="5" />
      </svg>}
      {state === 'reused' && <svg viewBox="0 0 16 16" aria-hidden="true" className="file-reused-icon">
        <path d="M2.3 8.1a5.9 5.9 0 0 1 10.8-2.2m.3-3v4.4H9" />
        <rect x="4.2" y="10" width="7.6" height="3.4" rx=".7" />
      </svg>}
    </span>}
  </td>;
}

const fileStatusGuide = [
  { state: 'pending', status: '待处理', description: '文件已加入队列，等待处理。' },
  { state: 'copy', status: '复制中', percent: 55, description: '进度环显示当前文件写入的比例。' },
  { state: 'verify', status: '校验中', percent: 55, description: '进度环显示当前文件在该读取阶段的比例。' },
  { state: 'await_verify', status: phases.await_verify, description: '已写入临时文件，等待校验。' },
  { state: 'copied', status: outcomeLabels.copied, description: '文件已写入目标，未配置校验。' },
  { state: 'verified', status: outcomeLabels.verified, description: '来源与目标的校验值一致。' },
  { state: 'reused', status: outcomeLabels.reused, description: skippedDescription },
  { state: 'failed', status: outcomeLabels.failed, description: '处理失败，悬浮文件状态可查看原因。' },
  { state: 'cancelled', status: outcomeLabels.cancelled, description: '任务取消后，此文件未完成。' },
] as const;

function FileStatusGuide() {
  return <details className="file-status-guide">
    <summary>状态说明</summary>
    <div className="file-status-panel"><table aria-label="文件状态说明">
      <thead><tr><th>图标</th><th>状态</th><th>说明</th></tr></thead>
      <tbody>{fileStatusGuide.map(item => <tr key={item.state}>
        <FileStatus state={item.state} status={item.status} percent={'percent' in item ? item.percent : undefined} />
        <td>{item.status}</td><td>{item.description}</td>
      </tr>)}</tbody>
    </table></div>
  </details>;
}

const fileColumns = ['来源', '目标路径', '大小', '复制策略', '校验策略', '来源哈希', '目标哈希', '状态'];
const fileRowHeight = 44;
const overscanRows = 12;

function QueueFileList({ plan, activePath, renderRow }: {
  plan: Plan; activePath?: string; renderRow(row: PlanRow, index: number): React.ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(260);
  useLayoutEffect(() => {
    const list = viewport.current;
    if (!list) return;
    const measure = () => setListHeight(list.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    measure();
    return () => observer.disconnect();
  }, []);
  const [follow, setFollow] = useState(true);
  const [widths, setWidths] = useState<number[]>();
  const drag = useRef<{ index: number; x: number; widths: number[] }>(null);
  const active = useMemo(() => plan.rows.findIndex(row => row.destination === activePath), [plan.rows, activePath]);

  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
    setScrollTop(0);
  }, [plan.id]);

  useLayoutEffect(() => {
    const list = viewport.current;
    if (!follow || active < 0 || !list) return;
    const header = list.querySelector('thead')?.clientHeight ?? 0;
    const visibleHeight = list.clientHeight - header;
    const top = active * fileRowHeight;
    if (top < list.scrollTop || top + fileRowHeight > list.scrollTop + visibleHeight) {
      list.scrollTop = Math.max(0, top - Math.floor((visibleHeight - fileRowHeight) / 2));
      setScrollTop(list.scrollTop);
    }
  }, [follow, active, plan.id, listHeight]);

  const first = Math.max(0, Math.floor(scrollTop / fileRowHeight) - overscanRows);
  const last = Math.min(plan.rows.length, Math.ceil((scrollTop + listHeight) / fileRowHeight) + overscanRows);
  const columnWidths = () => Array.from(viewport.current?.querySelectorAll('th') ?? [], header => header.getBoundingClientRect().width);
  const resize = (index: number, base: number[], delta: number) =>
    setWidths(base.map((width, column) => column === index ? Math.max(44, width + delta) : width));
  const spacer = (rows: number) => rows > 0 && <tr className="file-list-spacer" aria-hidden="true">
    <td colSpan={fileColumns.length} style={{ height: rows * fileRowHeight }} />
  </tr>;

  return <>
    <label className="file-list-follow"><input type="checkbox" checked={follow}
      onChange={event => setFollow(event.target.checked)} />自动滚动到当前文件</label>
    <div className="table" ref={viewport} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      <table aria-rowcount={plan.rows.length + 1}
        style={widths ? { width: widths.reduce((sum, width) => sum + width, 0), minWidth: 0 } : undefined}>
        <colgroup>{fileColumns.map((title, index) =>
          <col key={title} className={widths ? undefined : `file-col-${index}`} style={widths ? { width: widths[index] } : undefined} />
        )}</colgroup>
        <thead><tr>{fileColumns.map((title, index) => <th key={title} scope="col">
          {title}
          <span className="file-column-resize" role="separator" aria-orientation="vertical"
            aria-label={`调整${title}列宽`} tabIndex={0}
            onPointerDown={event => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { index, x: event.clientX, widths: columnWidths() };
            }}
            onPointerMove={event => {
              const start = drag.current;
              if (start?.index === index) resize(index, start.widths, event.clientX - start.x);
            }}
            onLostPointerCapture={() => { drag.current = null; }}
            onKeyDown={event => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              resize(index, columnWidths(), event.key === 'ArrowLeft' ? -12 : 12);
            }} />
        </th>)}</tr></thead>
        <tbody>{spacer(first)}
          {plan.rows.slice(first, last).map((row, index) => renderRow(row, first + index))}
          {spacer(plan.rows.length - last)}
        </tbody>
      </table>
    </div>
  </>;
}

function HashCell({ sums, algorithm, label, comparison }: {
  sums?: Checksums; algorithm?: string; label: string; comparison?: 'match' | 'mismatch';
}) {
  const hash = algorithm && sums?.[algorithm];
  const short = hash && hash.length >= 8 ? `${hash.slice(0, 4)}:${hash.slice(-4)}`.toUpperCase() : hash;
  return <td className="file-hash" data-comparison={comparison}
    title={hash ? `${label}\n${Object.entries(sums ?? {}).map(([name, value]) => name + ': ' + value).join('\n')}` : label}>
    {short || '—'}
  </td>;
}
declare global {
  interface Window {
    filebraid: {
      directory(): Promise<string | null>;
      shootingMedia(): Promise<ShootingMedia[]>;
      sonyStructure(source: SonySource): Promise<boolean>;
      directoryItems(folder: string, relative: string): Promise<FolderEntry[]>;
      open(): Promise<unknown>;
      save(workflow: Workflow): Promise<boolean>;
      listLibraryWorkflows(): Promise<LibraryWorkflow[]>;
      openLibraryWorkflow(id: string): Promise<unknown>;
      saveLibraryWorkflow(name: string, workflow: Workflow): Promise<LibraryWorkflow>;
      removeLibraryWorkflow(id: string): Promise<void>;
      preview(workflow: Workflow): Promise<Plan>;
      execute(id: string, verifyOnly?: boolean): Promise<{ outcomes: Outcome[] }>;
      removeTask(id: string): Promise<void>;
      cancel(): Promise<boolean>;
      control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<boolean>;
      recover(): Promise<{ workflow: unknown; status: 'finished' | 'incomplete' | 'interrupted'; date: string; count: number } | null>;
      report(id: string, format: 'html' | 'json'): Promise<boolean>;
      onProgress(callback: (id: string, event: Outcome | CopyProgress) => void): () => void;
    };
  }
}

const officialFolders = directoryChain('项目/A机/卡001');
const officialWorkflow: Workflow = {
  version: 4,
  nodes: [
    { id: 'source', kind: 'source', value: '', x: 0, y: 30 },
    { id: 'directory', kind: 'outputtree', value: JSON.stringify(officialFolders), x: 570, y: 30 },
    { id: 'copy-a', kind: 'copy', value: '', x: 905, y: 0 },
    { id: 'copy-b', kind: 'copy', value: '', x: 905, y: 235 },
    { id: 'a', kind: 'target', value: '', x: 1190, y: 0 },
    { id: 'b', kind: 'target', value: '', x: 1190, y: 235 },
    { id: 'sha256', kind: 'sha256', value: '', x: 570, y: 365 },
    { id: 'standardcopy', kind: 'standardcopy', value: '', x: 285, y: 365 },
  ],
  edges: [
    ['source', 'directory', `folder:${officialFolders.at(-1)!.id}`],
    ['directory', 'copy-a', 'files'], ['directory', 'copy-b', 'files'],
    ['sha256', 'copy-a', 'verify'], ['sha256', 'copy-b', 'verify'],
    ['standardcopy', 'copy-a', 'transfer'], ['standardcopy', 'copy-b', 'transfer'],
    ['copy-a', 'a', 'operation'], ['copy-b', 'b', 'operation'],
  ].map(([source, target, targetHandle]) => ({ id: source + ':' + target, source, target, targetHandle })),
};

const sonyWorkflow: Workflow = {
  ...officialWorkflow,
  nodes: [...officialWorkflow.nodes, { id: 'camera', kind: 'camera', value: '', x: 285, y: 30 }],
  edges: officialWorkflow.edges.filter(edge => edge.source !== 'source').concat([
    { id: 'source:camera', source: 'source', target: 'camera', targetHandle: 'files' },
    { id: 'camera:directory', source: 'camera', target: 'directory', targetHandle: `folder:${officialFolders.at(-1)!.id}` },
  ]),
};

function canvasNode(node: WorkflowNode): FlowNode {
  return {
    id: node.id,
    type: 'blueprint',
    dragHandle: '.node-title, .node-field, .path, .node-note',
    width: node.width,
    height: node.height,
    position: { x: node.x, y: node.y },
    data: { kind: node.kind, value: node.value, group: node.group, groupName: node.groupName },
    className: isAlgorithm(node.kind) || port(node.kind) === 'transfer' ? 'kind-algorithm' : 'kind-' + node.kind,
  };
}

const NodeActions = createContext<{
  update(id: string, value: string): void;
  chooseDirectory(id: string): void;
  busy: boolean;
  treeFolders: ReadonlyMap<string, string>;
  sonySources: ReadonlyMap<string, SonySource | null>;
  destinationFolders: ReadonlyMap<string, string>;
  removeFolderConnections(id: string, folders: ReadonlySet<string>): void;
  pinMenu(event: MouseEvent, pin: Pin): void;
  disconnect(pin: Pin): void;
} | null>(null);

function useShootingMedia(enabled = true) {
  const [devices, setDevices] = useState<ShootingMedia[]>();
  const [problem, setProblem] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number;
    async function refresh() {
      try {
        const devices = await window.filebraid.shootingMedia();
        if (active) { setDevices(devices); setProblem(false); }
      } catch {
        if (active) { setDevices([]); setProblem(true); }
      }
      if (active) timer = window.setTimeout(refresh, 3000);
    }
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [enabled]);
  return { devices, problem };
}

function MediaControl({ value, update }: { value: string; update(value: string): void }) {
  const { devices, problem } = useShootingMedia();
  const selected = devices?.find(device => mediaSelection(device) === value);
  return <label className="verify-timing">来源设备
    <select aria-label="来源拍摄介质" value={selected ? value : ''} onChange={event => update(event.target.value)}>
      <option value="">{value ? '介质已离线或盘符变化' : devices ? '请选择设备' : '正在检测…'}</option>
      {devices?.map(device => <option key={device.root} value={mediaSelection(device)}>
        {device.root} · {mediaTypes[device.type]} {device.mediaModel ?? device.deviceModel ?? ''}
      </option>)}
    </select>
    <span className={problem ? 'node-note error' : 'node-note'}>
      {problem ? '读取拍摄介质失败，正在重试。' : selected
        ? `介质序列号：${selected.mediaSerial ?? '未读取'}`
        : devices?.length === 0 ? '暂无可用介质，插入后自动刷新。' : '插入介质后自动刷新。'}
    </span>
    {selected?.deviceSerial && selected.deviceSerial !== selected.mediaSerial &&
      <span className="node-note" title="Windows 提供的设备序列号，可能属于相机或读卡器">
        系统设备序列号：{selected.deviceSerial}
      </span>}
  </label>;
}

function SonyStatus({ source }: { source: SonySource | null | undefined }) {
  const kind = source?.kind;
  const value = source?.value;
  const output = source?.output;
  const { devices, problem } = useShootingMedia(kind === 'media' && Boolean(value));
  const available = kind !== 'media' || devices?.some(device => mediaSelection(device) === value);
  const [result, setResult] = useState<{ key: string; sony?: boolean; error?: string }>();
  const key = JSON.stringify([kind, value, output]);
  useEffect(() => {
    if (!kind || !value || !output || !available) return;
    let active = true;
    window.filebraid.sonyStructure({ kind, value, output }).then(
      sony => { if (active) setResult({ key, sony }); },
      error => { if (active) setResult({ key, error: String(error.message ?? error) }); },
    );
    return () => { active = false; setResult(undefined); };
  }, [available, key, kind, value, output]);
  const match = available && result?.key === key ? result : undefined;
  const label = source === undefined ? '请连接文件来源' : source === null ? '将在入队时检查上游处理结果'
    : !value ? '请在上游选择介质或目录'
      : problem && kind === 'media' ? '无法读取上游介质'
        : available === false ? '上游介质已离线或盘符变化'
          : match?.sony === true ? '已识别为 Sony 卡目录'
            : match?.sony === false ? '未识别到 Sony 卡目录'
              : match?.error ? '无法检查 Sony 卡目录' : '正在检查 Sony 卡目录…';
  return <>
    <span className={match?.sony === true ? 'node-note sony-recognized' :
      match?.sony === false || match?.error ? 'node-note error' : 'node-note'}
      role="status" title={match?.error}>{label}</span>
    <span className="node-note">整卡备份接「全部文件」。</span>
  </>;
}

function CopyControls({ value, update }: { value: string; update(value: string): void }) {
  const feedbackId = useId();
  let config = copyDefaults;
  try {
    if (value.trim().startsWith('{')) config = { ...copyDefaults, ...JSON.parse(value) };
    else if ([1, 2, 4, 8].includes(Number(value))) {
      const block = Number(value);
      config = { ...copyDefaults, block_mib: block, buffer_mib: block * 3, queue_depth: 3, small_file_kib: block * 2048, mode: 'parallel' };
    }
  } catch { /* Preview reports invalid serialized settings. */ }
  const set = <K extends keyof CopySettings,>(key: K, next: CopySettings[K]) =>
    update(JSON.stringify({ ...config, [key]: next }));
  const fields = [
    ['buffer_mib', '主缓冲区 · MiB', 1, undefined], ['block_mib', 'I/O 单位 · MiB', 1, 32],
    ['queue_depth', '在途缓冲块', 1, 32], ['small_file_kib', '小文件阈值 · KiB', 0, 65536],
    ['limit_mib_s', '限速 · MiB/s', 0, 10000],
  ] as const;
  const invalidField = fields.find(([key, , min, max]) =>
    !Number.isSafeInteger(config[key]) || config[key] < min || (max !== undefined && config[key] > max));
  const bufferTooSmall = config.buffer_mib < config.block_mib;
  const error = invalidField
    ? `${invalidField[1]}：请输入${invalidField[3] === undefined ? `至少为 ${invalidField[2]}` : ` ${invalidField[2]}–${invalidField[3]}`}的整数。`
    : bufferTooSmall ? `主缓冲区至少需要 ${config.block_mib} MiB，才能容纳一个 I/O 块。` : '';
  const slots = config.block_mib > 0 ? Math.min(config.queue_depth, Math.floor(config.buffer_mib / config.block_mib)) : 0;
  return <div className="copy-settings">
    <label>读写模式
      <select value={config.mode} onChange={event => set('mode', event.target.value as CopyMode)}>
        <option value="auto">自动判断</option>
        <option value="parallel">并行读写</option>
        <option value="batch">分批读写</option>
      </select>
    </label>
    <div className="copy-fields">
      {fields.map(([key, label, min, max]) => <label key={key}>{label}
        <input type="number" min={min} max={max} step={1} value={config[key]}
          aria-invalid={invalidField?.[0] === key || (!invalidField && bufferTooSmall && key === 'buffer_mib')}
          aria-describedby={feedbackId}
          disabled={key === 'queue_depth' && config.mode === 'batch'}
          onChange={event => set(key, Number(event.target.value))} />
      </label>)}
    </div>
    <label className="copy-toggle"><input type="checkbox" checked={config.low_io}
      onChange={event => set('low_io', event.target.checked)} />低 I/O 优先级（Windows）</label>
    <span id={feedbackId} aria-live="polite" className={error ? 'node-note error' : 'node-note'}>
      {error || (config.mode === 'batch' ? '分批时按主缓冲区读入，再以 I/O 单位写出。'
        : slots === 1 ? `同步读写，每块 ${config.block_mib} MiB。`
          : `并行缓冲最多 ${slots} 个块，共 ${slots * config.block_mib} MiB。`)}
    </span>
  </div>;
}

type TreeRows = {
  observe(path: string, row: HTMLDivElement): () => void;
  visible: ReadonlySet<string>;
  connected: ReadonlySet<string>;
  direction: HandleType;
  handle(path: string): React.ReactNode;
};

function FolderBranch({ folder, relative, rows }: { folder: string; relative: string; rows: TreeRows }) {
  const [entries, setEntries] = useState<FolderEntry[]>();
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let current = true;
    window.filebraid.directoryItems(folder, relative).then(
      items => { if (current) setEntries(items); },
      error => { if (current) setProblem(String(error.message ?? error).replace(/^Error invoking remote method '[^']+': Error: /, '')); },
    );
    return () => { current = false; };
  }, [folder, relative]);
  if (problem) return <p className="error">{problem}</p>;
  if (!entries) return <p>正在读取…</p>;
  if (!entries.length) return <p>此文件夹为空。</p>;
  return <ul>{entries.map(entry => {
    const path = relative ? relative + '/' + entry.name : entry.name;
    return <FolderItem key={path} entry={entry} folder={folder} relative={path} rows={rows} />;
  })}</ul>;
}

function FolderItem({ entry, folder, relative, rows }: {
  entry: FolderEntry; folder: string; relative: string; rows: TreeRows;
}) {
  const [expanded, setExpanded] = useState(false);
  const { observe, direction } = rows;
  const connectable = direction === 'source' || entry.directory;
  const rowRef = useCallback((row: HTMLDivElement | null) => {
    if (row && connectable) return observe(relative, row);
  }, [observe, relative, connectable]);
  return <li>
    <div className={`source-tree-row node-port tree-${direction}`} ref={rowRef} data-connected={rows.connected.has(relative)}>
      {entry.directory ? <button title={entry.name} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? '▾' : '▸'} {entry.name}
      </button> : <span title={entry.name}>{entry.name}</span>}
      {connectable && rows.visible.has(relative) && rows.handle(relative)}
    </div>
    {expanded && <FolderBranch folder={folder} relative={relative} rows={rows} />}
  </li>;
}

function DiskTree({ id, folder, direction, handle }: { id: string; folder: string; direction: HandleType; handle: TreeRows['handle'] }) {
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const scroll = useRef<HTMLDivElement>(null);
  const observed = useRef(new Map<Element, string>());
  const observer = useRef<IntersectionObserver>(null);
  const updateInternals = useUpdateNodeInternals();
  const connections = useNodeConnections({ handleType: direction });
  const prefix = direction === 'source' ? 'item:' : 'disk:';
  // Keep a single handle for a connected path, even when its row is folded or scrolled away.
  const connected = new Set(connections.flatMap(connection => {
    const id = direction === 'source' ? connection.sourceHandle : connection.targetHandle;
    return id?.startsWith(prefix) ? [id.slice(prefix.length)] : [];
  }));

  const observe = useCallback((path: string, row: HTMLDivElement) => {
    observed.current.set(row, path);
    observer.current?.observe(row);
    return () => {
      observer.current?.unobserve(row);
      observed.current.delete(row);
      setVisible(previous => {
        if (!previous.has(path)) return previous;
        const next = new Set(previous);
        next.delete(path);
        return next;
      });
    };
  }, []);

  useEffect(() => {
    const root = scroll.current;
    if (!root) return;
    const visibility = new IntersectionObserver(entries => {
      setVisible(previous => {
        const next = new Set(previous);
        let changed = false;
        for (const entry of entries) {
          const path = observed.current.get(entry.target);
          if (path === undefined) continue;
          const shown = entry.isIntersecting && entry.intersectionRatio >= 0.99;
          if (shown === next.has(path)) continue;
          if (shown) next.add(path);
          else next.delete(path);
          changed = true;
        }
        return changed ? next : previous;
      });
    }, { root, threshold: 0.99 });
    observer.current = visibility;
    for (const row of observed.current.keys()) visibility.observe(row);
    const layout = new ResizeObserver(() => updateInternals(id));
    if (root.firstElementChild) layout.observe(root.firstElementChild);
    return () => {
      observer.current = null;
      visibility.disconnect();
      layout.disconnect();
    };
  }, [expanded, id, updateInternals]);

  useEffect(() => { updateInternals(id); }, [id, expanded, visible, connections, updateInternals]);

  return <div className="source-tree">
    <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? '收起' : '展开'}{direction === 'source' ? '文件夹树' : '输出目录树'}
    </button>
    {[...connected].filter(path => !expanded || !visible.has(path)).map(path =>
      <div className={`node-port route-port ${direction === 'source' ? 'node-port-output' : 'tree-target-route'}`} key={path} title={path}>
        <span>{path}</span>{handle(path)}
      </div>)}
    {expanded && <div className="source-tree-scroll" ref={scroll} onScroll={() => updateInternals(id)}>
      <div><FolderBranch folder={folder} relative="" rows={{ observe, visible, connected, direction, handle }} /></div>
    </div>}
  </div>;
}

function TargetTree({ id, value, input }: { id: string; value: string; input(handle: string, name: string): React.ReactNode }) {
  const actions = useContext(NodeActions)!;
  const folders = useMemo(() => outputFolders(value), [value]);
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => { updateInternals(id); }, [id, folders, updateInternals]);
  const save = (entries: OutputFolder[]) => actions.update(id, JSON.stringify(entries));

  function add(parent?: string) {
    if (folders.length >= maxOutputFolders) return;
    const siblings = new Set(folders.filter(folder => (folder.parent ?? undefined) === parent).map(folder => folder.name));
    let name = '新文件夹';
    for (let n = 2; siblings.has(name); n++) name = `新文件夹 ${n}`;
    save([...folders, { id: crypto.randomUUID(), name, parent }]);
  }

  function remove(idToRemove: string) {
    const removed = new Set([idToRemove]);
    for (const folder of folders) {
      if (folder.parent && removed.has(folder.parent)) removed.add(folder.id);
    }
    actions.removeFolderConnections(id, removed);
    save(folders.filter(folder => !removed.has(folder.id)));
  }

  const byParent = new Map<string | undefined, OutputFolder[]>();
  for (const folder of folders) {
    const parent = folder.parent ?? undefined;
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(folder);
    else byParent.set(parent, [folder]);
  }

  function move(parent: string | undefined, index: number, offset: -1 | 1) {
    const siblings = byParent.get(parent);
    const next = index + offset;
    if (!siblings || next < 0 || next >= siblings.length) return;
    const reordered = [...siblings];
    [reordered[index], reordered[next]] = [reordered[next], reordered[index]];

    // Keep each parent before its children in the saved folder list.
    const inOrder = (level?: string): OutputFolder[] => {
      const children = level === parent ? reordered : byParent.get(level) ?? [];
      return children.flatMap(folder => [folder, ...inOrder(folder.id)]);
    };
    save(inOrder());
  }

  function branch(parent?: string, depth = 0): React.ReactNode {
    const siblings = byParent.get(parent) ?? [];
    return siblings.map((folder, index) =>
      <li key={folder.id} style={{ '--tree-indent': `${Math.min(depth, 6) * 12}px` } as CSSProperties}>
        <div className="target-tree-row node-port">
          {input(`folder:${folder.id}`, folder.name || '未命名文件夹')}
          <div className="tree-row">
            <span className="folder-icon" aria-hidden="true" />
            <input aria-label="目标文件夹名称" value={folder.name} placeholder="文件夹名"
              onChange={event => save(folders.map(item => item.id === folder.id ? { ...item, name: event.target.value } : item))} />
            <button type="button" disabled={index === 0} title="同级上移"
              aria-label={`上移 ${folder.name}`} onClick={() => move(parent, index, -1)}>↑</button>
            <button type="button" disabled={index === siblings.length - 1} title="同级下移"
              aria-label={`下移 ${folder.name}`} onClick={() => move(parent, index, 1)}>↓</button>
            <button type="button" disabled={folders.length >= maxOutputFolders} title="添加同级文件夹"
              aria-label={`在 ${folder.name} 同级添加文件夹`} onClick={() => add(parent)}>＋同级</button>
            <button type="button" disabled={folders.length >= maxOutputFolders} title="添加子文件夹"
              aria-label={`在 ${folder.name} 中添加子文件夹`} onClick={() => add(folder.id)}>＋子级</button>
            <button type="button" title="移除此文件夹及其子项的连线" aria-label={`移除 ${folder.name}`}
              onClick={() => remove(folder.id)}>×</button>
          </div>
        </div>
        {byParent.has(folder.id) && <ul>{branch(folder.id, depth + 1)}</ul>}
      </li>);
  }

  return <div className="target-tree">
    <div className="node-field">规划目录</div>
    {folders.length > 0 && <ul aria-label="目标目录树">{branch()}</ul>}
    <button type="button" disabled={folders.length >= maxOutputFolders} onClick={() => add()}>＋ 添加顶层文件夹</button>
  </div>;
}

function BlueprintNode({ id, data, selected }: NodeProps<FlowNode>) {
  const actions = useContext(NodeActions)!;
  const { kind, value } = data;
  const strategy = port(kind);
  const policy = strategy === 'transfer' || strategy === 'verify';
  const isPath = kind === 'source' || kind === 'tree' || kind === 'target';
  const linked = kind === 'tree' && actions.treeFolders.has(id);
  const folder = linked ? actions.treeFolders.get(id)! : value;
  const destination = actions.destinationFolders.get(id);
  const exclude = value.startsWith('exclude:');
  function pinProps(direction: HandleType, handle: string) {
    const pin = { nodeId: id, direction, handle };
    const label = portLabel(kind, direction, handle);
    const sonyOutput = kind === 'camera' && direction === 'source' ? sonyOutputs.find(output => output.id === handle) : undefined;
    const detail = sonyOutput ? sonyOutput.detail : handle === 'operation'
      ? `接收「${labels.copy}」的输出，指定这一步复制的落盘目录`
      : direction === 'source' && kind === 'copy'
        ? '计划写入的文件，需连接「目标目录」；启动任务后才实际写入'
      : direction === 'target' && handle === 'files' && kind === 'tree'
        ? `连接「${labels.source}」，使用其所选目录展开文件树`
      : direction === 'target' && handle === 'files' && kind === 'outputtree'
        ? '接收直接归入目标根目录的文件，支持多路连接'
      : direction === 'target' && handle === 'files' && kind === 'merge'
        ? '支持多路连接，合并接入的文件'
      : handle === 'exclude' ? '按来源路径排除匹配文件，接收一路文件；不会删除原文件'
      : direction === 'target' && handle === 'files' && kind === 'subtract'
        ? '接收需要处理的文件；从中排除「排除文件」指定的条目'
      : direction === 'target' && handle === 'transfer' ? '必接，选择一项复制策略'
      : direction === 'target' && handle === 'verify' ? '可选，支持多个不同算法，校验时机须一致'
      : direction === 'source' && kind === 'tree' ? '当前来源目录中的全部文件'
      : direction === 'source' && kind === 'outputtree' ? '完成目标目录分配的文件'
      : direction === 'source' && kind === 'source' ? '所选目录内的文件；连接目录树时提供该目录'
      : direction === 'source' ? '拖到空白处添加兼容节点' : '右键查看连接';
    return {
      'aria-label': label + (direction === 'source' ? ' · 输出端口' : ' · 输入端口'),
      title: label + ' · ' + detail,
      onContextMenu: (event: MouseEvent) => {
        event.stopPropagation();
        actions.pinMenu(event, pin);
      },
      onMouseDownCapture: (event: MouseEvent) => {
        if (event.button === 0 && event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          actions.disconnect(pin);
        }
      },
    };
  }
  const mainOutput = <div className={`node-port node-port-output ${strategy === 'operation' ? 'operation' :
    strategy === 'transfer' ? 'transfer' : policy ? 'policy' : ''}`}>
    {portLabel(kind, 'source', 'out')}
    <Handle id="out" type="source" position={Position.Right} {...pinProps('source', 'out')} />
  </div>;
  return <>
    {selected && (isPath || kind === 'outputtree') && <NodeResizeControl position="bottom-right" minHeight={kind === 'tree' || kind === 'outputtree' ? 225 : 125} maxHeight={1600}
      minWidth={kind === 'tree' || kind === 'outputtree' ? 285 : 210} maxWidth={1800} className="path-resize nodrag" />}
    <div className="node-title">{labels[kind]}</div>
    <div className="node-ports">
      {kind === 'outputtree' && mainOutput}
      {kind === 'target' && <div className="node-port operation">
        <Handle id="operation" type="target" position={Position.Left} {...pinProps('target', 'operation')} /> {portLabel(kind, 'target', 'operation')}
      </div>}
      {!isFileSource(kind) && kind !== 'target' && kind !== 'outputtree' && !policy && <div className="node-port">
        <Handle id="files" type="target" position={Position.Left} {...pinProps('target', 'files')} />
        {portLabel(kind, 'target', 'files')}
      </div>}
      {kind === 'subtract' && <div className="node-port">
        <Handle id="exclude" type="target" position={Position.Left} {...pinProps('target', 'exclude')} /> {portLabels.exclude}
      </div>}
      {kind === 'copy' && <div className="node-port transfer">
        <Handle id="transfer" type="target" position={Position.Left} {...pinProps('target', 'transfer')} /> {portLabels.transfer}
      </div>}
      {kind === 'copy' && <div className="node-port policy">
        <Handle id="verify" type="target" position={Position.Left} {...pinProps('target', 'verify')} /> {portLabels.verify}
      </div>}
      {kind !== 'target' && kind !== 'outputtree' && kind !== 'tree' && kind !== 'camera' && mainOutput}
      {kind === 'camera' && sonyOutputs.map(({ id, label }) =>
        <div className="node-port node-port-output" key={id}>
          {label}<Handle id={id} type="source" position={Position.Right} {...pinProps('source', id)} />
        </div>)}
    </div>
    {kind !== 'copy' && <div className="node-body nowheel" onClick={event => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, button, a, [contenteditable]')) {
        event.stopPropagation();
      }
    }}>
      {isPath && <>
        <div className="node-field">{kind === 'target' ? '目标目录' : linked ? '已连接的来源目录' : '来源目录'}</div>
        <div className="path" title={folder}>{folder || (linked ? `请在上游「${labels.source}」选择目录` : '尚未选择目录')}</div>
        {!linked && <button disabled={actions.busy} onClick={() => actions.chooseDirectory(id)}>选择文件夹</button>}
      </>}
      {kind === 'tree' && <div className="node-port node-port-output source-root-port">
        <span className="node-field">输出全部文件</span>
        {portLabel(kind, 'source', 'out')}
        <Handle id="out" type="source" position={Position.Right} {...pinProps('source', 'out')}
          aria-label="文件 · 整棵来源目录树的输出端口" />
      </div>}
      {kind === 'tree' && folder && <DiskTree key={folder} id={id} folder={folder} direction="source" handle={relative => {
        const handle = `item:${relative}`;
        return <Handle id={handle} type="source" position={Position.Right} {...pinProps('source', handle)}
          aria-label={`文件输出端口 · ${relative}`} title={`文件 · 选取 ${relative}；文件夹包含其内部文件`} />;
      }} />}
      {kind === 'outputtree' && <>
        <div className="node-field">输出目录</div>
        {destination
          ? <div className="path" title={destination}>{destination}</div>
          : <span className="node-note">通过「{labels.copy}」连接一个已选定的「{labels.target}」，即可展开。</span>}
        <div className="node-port output-root-port">
          <Handle id="files" type="target" position={Position.Left} {...pinProps('target', 'files')}
            aria-label="文件 · 目标根目录输入端口" />
          {portLabel(kind, 'target', 'files')}
          <span className="node-field">写入目标根目录</span>
        </div>
        {destination && <DiskTree key={destination} id={id} folder={destination} direction="target" handle={relative =>
          <Handle id={`disk:${relative}`} type="target" position={Position.Left} {...pinProps('target', `disk:${relative}`)}
            aria-label={`文件输入端口 · ${relative}`} title={`文件 · 将接入的文件归入 ${relative}`} />
        } />}
        <TargetTree id={id} value={value} input={(handle, name) =>
          <Handle id={handle} type="target" position={Position.Left} {...pinProps('target', handle)}
            aria-label={`文件输入端口 · ${name}`} title={`文件 · 将接入的文件归入 ${name}`} />
        } />
      </>}
      {kind === 'filter' && <div className="verify-timing">
        <label>筛选方式 <select value={exclude ? 'exclude' : 'include'}
          onChange={event => actions.update(id, (event.target.value === 'exclude' ? 'exclude:' : '') + value.replace(/^exclude:/, ''))}>
          <option value="include">只保留匹配项</option><option value="exclude">排除匹配项</option>
        </select></label>
        <input aria-label="扩展名" placeholder="mp4, jpg" value={value.replace(/^exclude:/, '')}
          onChange={event => actions.update(id, (exclude ? 'exclude:' : '') + event.target.value)} />
        <span className="node-note">用逗号分隔。留空保留全部。</span>
      </div>}
      {kind === 'merge' && <span className="node-note">合并多条清单。相同源文件和相同落盘路径只保留一次。</span>}
      {kind === 'subtract' && <span className="node-note">从「文件」中排除「排除文件」指定的条目，按来源路径匹配；不会删除原文件。</span>}
      {kind === 'media' && <MediaControl value={value} update={next => actions.update(id, next)} />}
      {kind === 'camera' && <SonyStatus source={actions.sonySources.get(id)} />}
      {kind === 'fastcopy' && <CopyControls value={value} update={next => actions.update(id, next)} />}
      {kind === 'standardcopy' && <span className="node-field">通用文件流</span>}
      {isAlgorithm(kind) && <>
        <label className="verify-timing">校验时机
          <select value={value || 'per_file'} onChange={event => actions.update(id, event.target.value)}>
            <option value="per_file">{verifyTimingLabels.per_file}</option>
            <option value="after_copy">{verifyTimingLabels.after_copy}</option>
          </select>
        </label>
      </>}
    </div>}
  </>;
}

const nodeTypes = { blueprint: BlueprintNode };

function resolveLegacyFolderName(template: string, parameters?: Record<string, unknown>) {
  const text = template.replace(/\{(项目|日期|机位|卡次)\}/g, '');
  if (/[{}]/.test(text)) return '<请填写实际目录名>';
  return template.replace(/\{(项目|日期|机位|卡次)\}/g, (_, key: string) => {
    const value = parameters?.[key];
    if (typeof value !== 'string' || !value.trim() || /[<>:"/\\|?*\p{Cc}]|[. ]$/u.test(value) ||
      /^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9¹²³])$/i.test(value.split('.')[0].trimEnd())) return `<请填写${key}>`;
    return value;
  });
}

function decode(value: unknown): Workflow {
  const data = value as Partial<Omit<Workflow, 'version'> & { version: number; parameters: Record<string, unknown> }> | null;
  const version = data?.version;
  const limits = typeof version === 'number' && workflowLimits[version as keyof typeof workflowLimits];
  if (!data || typeof version !== 'number' || !limits || !Array.isArray(data.nodes) || !Array.isArray(data.edges)
    || data.nodes.length > limits[0] || data.edges.length > limits[1]) {
    throw new Error('不支持此工作流格式。');
  }
  if (!data.nodes.every(node => node && typeof node.id === 'string'
    && Object.hasOwn(labels, node.kind) && (version === 4 || node.kind !== 'copy') && typeof node.value === 'string'
    && Number.isFinite(node.x) && Number.isFinite(node.y))
    || new Set(data.nodes.map(node => node.id)).size !== data.nodes.length
    || !data.edges.every(edge => edge && typeof edge.id === 'string'
      && typeof edge.source === 'string' && typeof edge.target === 'string'
      && (edge.sourceHandle == null || typeof edge.sourceHandle === 'string')
      && (edge.targetHandle == null || typeof edge.targetHandle === 'string'))) {
    throw new Error('工作流含无效节点或连线。');
  }
  const nodes: WorkflowNode[] = data.nodes.map(({ id, kind, value, x, y, width, height, group, groupName }) => ({
    id, kind, value, x, y,
    width: typeof width === 'number' && width >= 210 && width <= 1800 ? width : undefined,
    height: typeof height === 'number' && height >= 125 && height <= 1600 ? height : undefined,
    group: typeof group === 'string' && group.length <= 80 && group ? group : undefined,
    groupName: typeof groupName === 'string' && groupName.length <= 80 ? groupName.trim() || undefined : undefined,
  }));
  const edges = data.edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle }));
  if (version < 3) {
    for (const node of nodes) {
      if (node.kind === 'directory') node.value = node.value.split('/')
        .map(part => resolveLegacyFolderName(part, data.parameters)).join('/');
      if (node.kind === 'outputtree') {
        const folders = outputFolders(node.value);
        if (folders.length) node.value = JSON.stringify(folders.map(folder => ({
          ...folder, name: resolveLegacyFolderName(folder.name, data.parameters),
        })));
      }
    }
  }
  if (version === 1) {
    const configured = copyStrategies(nodes, edges);
    const missing = nodes.filter(node => node.kind === 'target' && !configured.has(node.id));
    if (missing.length) {
      const id = crypto.randomUUID();
      nodes.push({ id, kind: 'standardcopy', value: '', x: Math.min(...missing.map(node => node.x)) - 285,
        y: Math.max(...nodes.map(node => node.y)) + 180 });
      for (const node of missing) {
        edges.push({ id: crypto.randomUUID(), source: id, target: node.id, sourceHandle: 'out', targetHandle: 'transfer' });
      }
    }
  }
  if (version < 4) {
    for (const target of nodes.filter(node => node.kind === 'target')) {
      const id = crypto.randomUUID();
      nodes.push({ id, kind: 'copy', value: '', x: target.x, y: target.y });
      target.x += 285;
      for (const edge of edges) {
        if (edge.target === target.id) edge.target = id;
      }
      edges.push({ id: crypto.randomUUID(), source: id, target: target.id, sourceHandle: 'out', targetHandle: 'operation' });
    }
  }
  for (const node of nodes) {
    if (node.kind !== 'directory') continue;
    const folders = directoryChain(node.value);
    const destination = `folder:${folders.at(-1)!.id}`;
    node.kind = 'outputtree';
    node.value = JSON.stringify(folders);
    // Route the old main input to the deepest folder to preserve the original path prefix.
    for (const edge of edges) {
      if (edge.target === node.id && (edge.targetHandle ?? 'files') === 'files') {
        edge.targetHandle = destination;
      }
    }
  }
  return { version: 4, nodes, edges };
}

function SpeedChart({ samples, readSamples, targets, duration, progress, live, activity, readOnly }: {
  samples: CopySpeedByTarget; readSamples: CopySpeedByTarget; targets: string[]; duration: number;
  progress: ReadonlyMap<string, TimedProgress>; live?: { write: number; read: number }; activity?: string; readOnly: boolean;
}) {
  const gradient = useId();
  const [visible, setVisible] = useState({ write: true, read: true });
  const end = Math.max(60, duration);
  const start = end - 60;
  const currentSamples = [...progress.values()].filter(event => {
    const kind = speedKind(event.phase);
    return kind && visible[kind] && duration - event.time <= 1.25;
  });
  const stableEnd = stableSpeedEnd(duration, !!live, currentSamples.map(event => event.time));
  const series = [
    { kind: 'write', history: samples, color: '#9add9f', label: '复制写入' },
    { kind: 'read', history: readSamples, color: '#80c6ef', label: '校验读取' },
  ] as const;
  const shown = series.filter(stream => visible[stream.kind]).map(({ history, ...stream }) => ({
    ...stream,
    intervals: continuousSpeed(speedIntervals(targets.map(target => history.get(target)), start, stableEnd)),
  }));
  const points = shown.flatMap(stream => stream.intervals);
  const peak = Math.max(0, ...points.map(point => point.speed));
  const liveRate = live && Math.max(visible.write ? live.write : 0, visible.read ? live.read : 0);
  const { maximum, step, unit } = transferSpeedAxis(points, stableEnd, liveRate);
  const ticks = [4, 3, 2, 1, 0];
  const x = (time: number) => (time - start) / (end - start) * 720;
  const y = (speed: number) => 124 - Math.min(speed, maximum) / maximum * 124;
  function trace(intervals: ReturnType<typeof speedIntervals>) {
    const points = intervals.map(interval => ({ x: x((interval.start + interval.end) / 2), y: y(interval.speed) }));
    const first = points[0];
    let curve = `M ${x(intervals[0].start)} ${first.y} H ${first.x}`;
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1];
      const to = points[index];
      const middle = (from.x + to.x) / 2;
      curve += ` C ${middle} ${from.y} ${middle} ${to.y} ${to.x} ${to.y}`;
    }
    return curve + ` H ${x(intervals[intervals.length - 1].end)}`;
  }

  return <figure className="speed-chart explorer-speed" data-chart={!visible.write && visible.read ? 'read' : undefined}>
    <figcaption><strong>传输速度</strong><span>{live && <b>实时合计 · 写入 {live.write ? byteSize(live.write) + '/s' : readOnly ? '无新写入' : '等待写入'} · 校验读取 {live.read ? byteSize(live.read) + '/s' : '—'}</b>}
      {!live && peak > 0 && <b>峰值 {byteSize(peak)}/s</b>}</span></figcaption>
    {activity && <div className="speed-activity">{activity}</div>}
    <div className="speed-plot">
      <div className="speed-y" aria-label={`速度刻度，单位 ${unit}`}>
        {ticks.map(tick => <span key={tick} style={{ top: `${(4 - tick) * 25}%` }}>
          {(tick * step).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}{tick === 4 ? ` ${unit}` : ''}
        </span>)}
      </div>
    <svg viewBox="0 0 720 124" preserveAspectRatio="none" role="img" aria-label="复制写入和校验读取速度">
      <defs>{series.map(stream => <linearGradient key={stream.kind} id={gradient + stream.kind} x1="0%" x2="0%" y1="0%" y2="100%">
        <stop offset="0%" stopColor={stream.color} stopOpacity=".5" />
        <stop offset="100%" stopColor={stream.color} stopOpacity=".12" />
      </linearGradient>)}</defs>
      {[0, 31, 62, 93, 124].map(tick => <line key={tick} x1="0" x2="720" y1={tick} y2={tick} className="chart-grid" />)}
      {shown.filter(stream => stream.intervals.length > 0).map(stream => {
        const curve = trace(stream.intervals);
        const rate = live?.[stream.kind] ?? 0;
        return <g key={stream.kind} data-speed={stream.kind}>
          <path d={`${curve} V 124 H ${x(stream.intervals[0].start)} Z`} fill={`url(#${gradient + stream.kind})`} />
          <path d={curve} fill="none" stroke={stream.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          {rate > 0 && <line x1="0" x2="720" y1={y(Math.min(rate, maximum))} y2={y(Math.min(rate, maximum))}
            className="speed-reference" stroke={stream.color} vectorEffect="non-scaling-stroke" />}
        </g>;
      })}
    </svg>
    </div>
    <div className="speed-window"><span>{start > 0 ? '最近 60 秒' : '本次任务'} · {duration.toFixed(0)} 秒
      {peak > maximum && ` · 超出刻度的峰值 ${byteSize(peak)}/s`}</span>
      <span className="chart-legend">{series.map(stream => <button key={stream.kind} type="button"
        aria-pressed={visible[stream.kind]} title={visible[stream.kind] ? `隐藏${stream.label}` : `显示${stream.label}`}
        onClick={() => setVisible(state => ({ ...state, [stream.kind]: !state[stream.kind] }))}>
        <i style={{ background: stream.color }} />{stream.label}
      </button>)}</span>
    </div>
  </figure>;
}

function NodeLibrary({ add }: { add(kind: Kind): void }) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const matches = (kind: Kind) => labels[kind].toLowerCase().includes(query) || kind.includes(query);
  return <div className="node-library" aria-label="节点库">
    <input type="search" aria-label="搜索节点" placeholder="搜索节点…" value={search}
      onChange={event => setSearch(event.target.value)} />
    {nodeGroups.map(group => {
      const kinds = group.kinds.filter(matches);
      if (!kinds.length) return null;
      const buttons = kinds.map(kind => <button key={kind} draggable
        onDragStart={event => {
          event.dataTransfer.setData(nodeDragType, kind);
          event.dataTransfer.effectAllowed = 'copy';
        }} onClick={() => add(kind)}>{labels[kind]}</button>);
      return query ? <div key={group.title} className="library-results">{buttons}</div>
        : <details key={group.title} open>
          <summary>{group.title}</summary>
          {buttons}
        </details>;
    })}
    {query && !nodeGroups.some(group => group.kinds.some(matches)) && <p>没有匹配的节点。</p>}
  </div>;
}

function WorkflowLibrary({ busy, load, save, remove, openWorkflow, saveWorkflow }: {
  busy: boolean;
  load(name: string, id?: string): void;
  save(name: string, added: (item: LibraryWorkflow) => void): void;
  remove(id: string, removed: () => void): void;
  openWorkflow(): void;
  saveWorkflow(): void;
}) {
  const [items, setItems] = useState<LibraryWorkflow[]>();
  const [problem, setProblem] = useState('');
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<string>();

  useEffect(() => {
    let active = true;
    window.filebraid.listLibraryWorkflows().then(
      result => { if (active) setItems(result); },
      () => { if (active) { setItems([]); setProblem('读取本机工作流失败。'); } },
    );
    return () => { active = false; };
  }, []);

  return <div className="workflow-library" aria-label="工作流库">
    <div className="workflow-file-actions">
      <button disabled={busy} onClick={openWorkflow}>打开工作流文件</button>
      <button disabled={busy} onClick={saveWorkflow}>保存工作流文件</button>
    </div>
    <h2>官方工作流</h2>
    <button className="workflow-choice" disabled={busy} onClick={() => load(officialWorkflowName)}>{officialWorkflowName}</button>
    <button className="workflow-choice" disabled={busy} onClick={() => load(sonyWorkflowName)}>{sonyWorkflowName}</button>
    <h2>我的工作流</h2>
    <form className="workflow-library-form" onSubmit={event => {
      event.preventDefault();
      if (!name.trim() || busy || !items) return;
      save(name, item => {
        setItems(previous => [item, ...(previous ?? [])]);
        setName('');
      });
    }}>
      <input aria-label="工作流名称" placeholder="工作流名称" value={name} maxLength={80}
        onChange={event => setName(event.target.value)} />
      <button type="submit" disabled={busy || !items || !name.trim()}>存到工作流库</button>
    </form>
    {problem && <p role="alert" className="error">{problem}</p>}
    {!items && <p role="status">正在读取工作流…</p>}
    {items?.map(item => <div className="workflow-library-row" key={item.id}>
      <button className="workflow-choice" title={item.name} disabled={busy} onClick={() => load(item.name, item.id)}>{item.name}</button>
      {confirm === item.id ? <>
        <button disabled={busy} onClick={() => remove(item.id, () => {
          setConfirm(undefined);
          setItems(previous => previous?.filter(entry => entry.id !== item.id));
        })}>确认删除</button>
        <button disabled={busy} onClick={() => setConfirm(undefined)}>取消</button>
      </> : <button aria-label={`删除工作流 ${item.name}`} disabled={busy} onClick={() => setConfirm(item.id)}>×</button>}
    </div>)}
  </div>;
}

function nodeSize(node: FlowNode) {
  return { width: node.measured?.width ?? node.width ?? 240, height: node.measured?.height ?? 100 };
}

type GraphMenu = { x: number; y: number; position: XYPosition; groupId?: string } &
  ({ type: 'pane' | 'selection' } | { type: 'connection' | 'pin'; pin: Pin });

function eventPoint(event: MouseEvent | globalThis.MouseEvent | TouchEvent) {
  const point = 'changedTouches' in event ? event.changedTouches[0] : event;
  return point ? { x: point.clientX, y: point.clientY } : undefined;
}

function isBlankDrop(event: globalThis.MouseEvent | TouchEvent) {
  const point = eventPoint(event);
  return point && document.elementFromPoint(point.x, point.y)?.classList.contains('react-flow__pane');
}

function edgeTouchesPin(edge: Edge, pin: Pin, nodes: FlowNode[]) {
  return pin.direction === 'source' ? edge.source === pin.nodeId && (edge.sourceHandle ?? 'out') === pin.handle :
    edge.target === pin.nodeId && (edge.targetHandle ?? port(nodes.find(node => node.id === edge.source)?.data.kind)) === pin.handle;
}

function App() {
  const [nodes, setNodes, changeNodes] = useNodesState(officialWorkflow.nodes.map(canvasNode));
  const [edges, setEdges, changeEdges] = useEdgesState(officialWorkflow.edges);
  const canvasRef = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<GraphMenu>();
  const [menuLevel, setMenuLevel] = useState(-1);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [groupDraft, setGroupDraft] = useState<string>();
  const [menuSearch, setMenuSearch] = useState('');
  const [minimap, setMinimap] = useState(true);
  const [mapHost, setMapHost] = useState<HTMLDivElement | null>(null);
  const [mapOptions, setMapOptions] = useState<MapOptions>({ color: false, edges: true, groups: true });
  const [toolMenu, setToolMenu] = useState<'mode' | 'zoom' | 'map'>();
  const [canvasMode, setCanvasMode] = useState<'select' | 'hand'>('hand');
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [showLinks, setShowLinks] = useState(true);

  const [compact, setCompact] = useState(false);
  const [frontNode, setFrontNode] = useState<string>();
  const reconnecting = useRef<string | null>(null);
  const [workflowName, setWorkflowName] = useState<string | undefined>(officialWorkflowName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<'workflow' | 'queue'>('workflow');
  const [library, setLibrary] = useState<'nodes' | 'workflows'>('nodes');
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<string>();
  const [queueRunning, setQueueRunning] = useState(false);
  const stopQueue = useRef(false);
  const task = tasks.find(item => item.plan.id === selectedTask);
  const result = task?.plan;
  const running = task?.status === 'running';
  const [queueClock, setQueueClock] = useState(0);
  useEffect(() => {
    if (!running || view !== 'queue') return;
    const timer = window.setInterval(() => setQueueClock(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [running, view]);
  const duration = Math.max(task?.speedElapsed ?? 0, running && task?.speedStart !== undefined
    ? (queueClock - task.speedStart) / 1000 : 0);
  function targetSpeed(id: string, kind: 'write' | 'read') {
    const current = task?.progress.get(id);
    const reading = task?.rates.get(id)?.[kind];
    if (!running || task?.control || !current || speedKind(current.phase) !== kind || !reading ||
      current.destination !== reading.destination || current.phase !== reading.phase || duration - reading.time > 1.25) return 0;
    return reading.rate;
  }
  const outcomes = task?.outcomes ?? new Map<string, Outcome>();
  const progress = task?.progress ?? new Map<string, TimedProgress>();
  const waiting = tasks.filter(item => item.status === 'waiting');
  const selectedNodes = nodes.filter(node => node.selected);
  const groups = new Map<string, FlowNode[]>();
  for (const node of nodes) {
    if (!node.data.group) continue;
    const members = groups.get(node.data.group) ?? [];
    members.push(node);
    groups.set(node.data.group, members);
  }
  const groupBoxes = [...groups].map(([group, members]) => {
    const left = Math.min(...members.map(node => node.position.x)) - 18;
    const top = Math.min(...members.map(node => node.position.y)) - 42;
    const right = Math.max(...members.map(node => node.position.x + nodeSize(node).width)) + 18;
    const bottom = Math.max(...members.map(node => node.position.y + nodeSize(node).height)) + 18;
    return { group, name: members[0].data.groupName ?? group, members, box: { left, top, width: right - left, height: bottom - top } };
  });
  const movingGroup = useRef<{ pointer: number; x: number; y: number; zoom: number; positions: Map<string, XYPosition> }>(null);
  const selectedEdges = edges.filter(edge => edge.selected);
  const hasSelection = selectedNodes.length + selectedEdges.length > 0;
  const linkedFolders = useMemo(() => treeInputs(nodes, edges), [nodes, edges]);
  const sonySources = useMemo(() => sonyInputs(nodes, edges), [nodes, edges]);
  const destinationFolders = useMemo(() => treeDestinations(nodes, edges), [nodes, edges]);
  const previousTreeRoots = useRef(new Map<string, string>());
  const previousDestinations = useRef(destinationFolders);
  useLayoutEffect(() => {
    const nextRoots = new Map(nodes.filter(node => node.data.kind === 'tree')
      .map(node => [node.id, linkedFolders.get(node.id) ?? node.data.value]));
    const changed = new Set([...nextRoots].filter(([id, root]) =>
      previousTreeRoots.current.has(id) && previousTreeRoots.current.get(id) !== root).map(([id]) => id));
    previousTreeRoots.current = nextRoots;
    const previousOutputs = previousDestinations.current;
    previousDestinations.current = destinationFolders;
    const staleSource = (edge: Edge) => changed.has(edge.source) && edge.sourceHandle?.startsWith('item:');
    const staleDestination = (edge: Edge) => edge.targetHandle?.startsWith('disk:') &&
      previousOutputs.has(edge.target) && previousOutputs.get(edge.target) !== destinationFolders.get(edge.target);
    const stale = (edge: Edge) => staleSource(edge) || staleDestination(edge);
    if (edges.some(stale)) {
      setEdges(items => items.filter(edge => !stale(edge)));
      setMessage(edges.some(staleDestination) ? '输出目录已更换，请重新连接目标文件夹。' : '来源目录已更换，请重新连接分流项目。');
    }
  }, [nodes, edges, linkedFolders, destinationFolders, setEdges]);
  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus();
  }, [menu]);
  useEffect(() => window.filebraid.onProgress((id, event) => {
    const time = performance.now();
    setTasks(previous => previous.map(item => {
      if (item.plan.id !== id) return item;
      const speedStart = item.speedStart ?? time;
      const speedElapsed = (time - speedStart) / 1000;
      const progress = new Map(item.progress);
      if ('kind' in event) {
        let { samples, readSamples, rates } = item;
        const previous = progress.get(event.target);
        const kind = speedKind(event.phase);
        if (kind && previous?.phase === event.phase && previous.destination === event.destination &&
          event.bytes > previous.bytes && Number.isFinite(event.bytes_per_second) && event.bytes_per_second > 0) {
          const buckets = new Map(kind === 'write' ? samples : readSamples);
          buckets.set(event.target, addSpeedSample(buckets.get(event.target) ?? new Map(),
            speedElapsed, event.bytes - previous.bytes, event.bytes_per_second));
          rates = new Map(rates).set(event.target, { ...rates.get(event.target),
            [kind]: { rate: event.bytes_per_second, time: speedElapsed, destination: event.destination, phase: event.phase } });
          if (kind === 'write') samples = buckets;
          else readSamples = buckets;
        }
        progress.set(event.target, { ...event, time: speedElapsed });
        const awaitingVerification = event.phase === 'await_verify'
          ? new Set(item.awaitingVerification).add(event.destination) : item.awaitingVerification;
        const sourceHashes = event.source_checksums && Object.keys(event.source_checksums).length
          ? new Map(item.sourceHashes).set(event.destination, event.source_checksums) : item.sourceHashes;
        return { ...item, progress, samples, readSamples, rates, awaitingVerification, sourceHashes, speedStart, speedElapsed };
      }
      if (progress.get(event.target)?.destination === event.destination) progress.delete(event.target);
      const awaitingVerification = new Set(item.awaitingVerification);
      awaitingVerification.delete(event.destination);
      return { ...item, progress, awaitingVerification, speedStart, speedElapsed, outcomes: new Map(item.outcomes).set(event.destination, event) };
    }));
  }), []);
  const canvasNodes = useMemo(() => nodes.map((node, index) => ({
    ...node,
    className: node.height ? node.className + ' path-node-sized' : node.className,
    zIndex: (node.selected ? 600 : 2) + index + (node.id === frontNode && node.selected ? 300 : 0),
  })), [nodes, frontNode]);
  const edgePins = edges.map(edge => {
    const input = port(nodes.find(entry => entry.id === edge.source)?.data.kind);
    return { ...edge, sourceHandle: edge.sourceHandle ?? 'out', targetHandle: edge.targetHandle ?? input, input };
  });
  const pinCounts = new Map<string, number>();
  const pinKey = (direction: HandleType, nodeId: string, handle: string) => JSON.stringify([direction, nodeId, handle]);
  for (const edge of edgePins) {
    const source = pinKey('source', edge.source, edge.sourceHandle);
    const target = pinKey('target', edge.target, edge.targetHandle);
    pinCounts.set(source, (pinCounts.get(source) ?? 0) + 1);
    pinCounts.set(target, (pinCounts.get(target) ?? 0) + 1);
  }
  const canvasEdges: Edge[] = edgePins.map(({ input, ...edge }) => {
    const chosen = edge.selected && selectedEdges.length === 1;
    const source = chosen || pinCounts.get(pinKey('source', edge.source, edge.sourceHandle)) === 1;
    const target = chosen || pinCounts.get(pinKey('target', edge.target, edge.targetHandle)) === 1;
    return {
      ...edge,
      interactionWidth: 18,
      reconnectable: source && target ? true : source ? 'source' : target ? 'target' : false,
      zIndex: edge.selected ? 1 : 0,
      style: input === 'operation' ? { stroke: '#f4ca7c' } : input === 'files' ? { stroke: '#79c9bc' } :
        { stroke: input === 'transfer' ? '#e7ac73' : '#adbbeb', strokeDasharray: '5 4' },
    };
  });
  const workflow: Workflow = {
    version: 4,
    nodes: nodes.map(entry => ({
      id: entry.id, kind: entry.data.kind, value: entry.data.value, x: entry.position.x, y: entry.position.y,
      width: entry.width, height: entry.height, group: entry.data.group, groupName: entry.data.groupName,
    })),
    edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle })),
  };
  const targetCounts = new Map<string, { planned: number; existing: number; succeeded: number; failed: number; cancelled: number; total: number; completed: number; workTotal: number; workDone: number; root: string }>();
  for (const row of result?.rows ?? []) {
    const count = targetCounts.get(row.target) ?? { planned: 0, existing: 0, succeeded: 0, failed: 0, cancelled: 0, total: 0, completed: 0, workTotal: 0, workDone: 0,
      root: displayPath(task?.workflow.nodes.find(node => node.id === row.target)?.value ?? row.target) };
    count.planned++;
    if (row.existing) count.existing++;
    count.total += row.bytes;
    const outcome = outcomes.get(row.destination);
    const current = running ? progress.get(row.target) : undefined;
    const work = fileWork(row, task?.verifyOnly === true, outcome?.status,
      current?.destination === row.destination ? current : undefined,
      running && task?.awaitingVerification.has(row.destination) === true);
    count.workTotal += work.total;
    count.workDone += work.done;
    if (outcome) {
      if (outcome.status === 'failed') count.failed++;
      else if (outcome.status === 'cancelled') count.cancelled++;
      else {
        count.succeeded++;
        count.completed += row.bytes;
      }
    }
    targetCounts.set(row.target, count);
  }

  function update(id: string, value: string) {
    setNodes(entries => entries.map(entry => entry.id === id ? { ...entry, data: { ...entry.data, value } } : entry));
  }

  function selectGraph(selected: boolean) {
    setNodes(entries => entries.map(node => ({ ...node, selected })));
    setEdges(entries => entries.map(edge => ({ ...edge, selected })));
  }

  function alignSelection(alignment: Alignment) {
    const arranging = selectedNodes.length ? selectedNodes : nodes;
    if (arranging.length < 2) return;
    const ids = new Set(arranging.map(node => node.id));
    const box = (node: FlowNode) => ({ id: node.id, ...node.position, ...nodeSize(node) });
    const positions = alignCanvas(arranging.map(box), nodes.filter(node => !ids.has(node.id)).map(box), alignment, edges);
    setNodes(items => items.map(node => {
      const position = positions.get(node.id);
      return position ? { ...node, position } : node;
    }));
    closeMenu();
  }

  function groupSelection(remove = false) {
    if (!selectedNodes.length) return;
    let number = 1;
    while (groups.has(`组 ${number}`)) number++;
    const group = remove ? undefined : `组 ${number}`;
    setNodes(items => items.map(node => node.selected ? { ...node, data: { ...node.data, group, groupName: undefined } } : node));
    closeMenu();
  }

  function renameGroup(groupId: string, name: string) {
    const groupName = name.trim();
    if (!groupName || groupName.length > 80) return;
    setNodes(items => items.map(node => node.data.group === groupId
      ? { ...node, data: { ...node.data, groupName } } : node));
    closeMenu();
  }

  function startGroupDrag(event: PointerEvent<HTMLDivElement>, members: FlowNode[]) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    movingGroup.current = {
      pointer: event.pointerId, x: event.clientX, y: event.clientY, zoom: flow.current?.getZoom() ?? 1,
      positions: new Map(members.map(node => [node.id, node.position])),
    };
  }

  function moveGroup(event: PointerEvent<HTMLDivElement>) {
    const dragging = movingGroup.current;
    if (!dragging || dragging.pointer !== event.pointerId) return;
    const dx = (event.clientX - dragging.x) / dragging.zoom;
    const dy = (event.clientY - dragging.y) / dragging.zoom;
    setNodes(items => items.map(node => {
      const origin = dragging.positions.get(node.id);
      return origin ? { ...node, position: { x: origin.x + dx, y: origin.y + dy } } : node;
    }));
  }

  function deleteSelection() {
    if (!hasSelection) return;
    const nodeIds = new Set(selectedNodes.map(node => node.id));
    const edgeIds = new Set(selectedEdges.map(edge => edge.id));
    setNodes(entries => entries.filter(node => !nodeIds.has(node.id)));
    setEdges(entries => entries.filter(edge =>
      !edgeIds.has(edge.id) && !nodeIds.has(edge.source) && !nodeIds.has(edge.target)));
    canvasRef.current?.focus({ preventScroll: true });
  }

  function closeMenu() {
    setMenu(undefined);
    canvasRef.current?.focus({ preventScroll: true });
  }

  function addNode(kind: Kind, position?: XYPosition, pin?: Pin) {
    const bounds = canvasRef.current?.getBoundingClientRect();
    const point = position ?? (bounds && flow.current?.screenToFlowPosition({
      x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2,
    })) ?? { x: 0, y: 0 };
    const id = crypto.randomUUID();
    const siblingStrategy = pin?.direction === 'target' && pin.handle === 'verify'
      ? edges.find(edge => edgeTouchesPin(edge, pin, nodes)) : undefined;
    const value = siblingStrategy
      ? nodes.find(node => node.id === siblingStrategy.source)?.data.value ?? '' : '';
    setNodes(entries => [...entries.map(node => ({ ...node, selected: false })),
      { ...canvasNode({ id, kind, value, x: point.x, y: point.y }), selected: true }]);
    setEdges(entries => {
      const next = entries.map(edge => ({ ...edge, selected: false }));
      if (!pin) return next;
      const sourceKind = nodes.find(node => node.id === pin.nodeId)?.data.kind;
      const connection: Connection = pin.direction === 'source'
        ? { source: pin.nodeId, sourceHandle: pin.handle, target: id, targetHandle: port(sourceKind) }
        : { source: id, sourceHandle: 'out', target: pin.nodeId, targetHandle: pin.handle };
      return addEdge(connection, next);
    });
    closeMenu();
  }

  function openMenu(event: MouseEvent | globalThis.MouseEvent | TouchEvent, action: Pick<GraphMenu, 'type' | 'groupId'> & { pin?: Pin }) {
    if (event.cancelable) event.preventDefault();
    const bounds = canvasRef.current?.getBoundingClientRect();
    const cursor = eventPoint(event);
    const x = cursor?.x || (bounds ? bounds.left + bounds.width / 2 : 0);
    const y = cursor?.y || (bounds ? bounds.top + bounds.height / 2 : 0);
    const position = flow.current?.screenToFlowPosition({ x, y }) ?? { x: 0, y: 0 };
    setMenuLevel(-1);
    setMenuSearch('');
    setOrganizeOpen(false);
    setGroupDraft(undefined);
    if (action.type === 'pane' || action.type === 'selection') setMenu({ x, y, position, type: action.type, groupId: action.groupId });
    else if (action.pin) setMenu({ x, y, position, type: action.type, pin: action.pin });
  }

  function disconnectPin(pin: Pin) {
    setEdges(items => items.filter(edge => !edgeTouchesPin(edge, pin, nodes)));
    closeMenu();
  }

  function compatibleNodes(pin: Pin) {
    const owner = nodes.find(node => node.id === pin.nodeId)?.data.kind;
    if (!owner) return [];
    if (pin.direction === 'source' && owner === 'copy' && edges.some(edge => edge.source === pin.nodeId)) return [];
    return nodeGroups.flatMap(group => group.kinds).filter(kind => {
      if (pin.direction === 'source') return acceptsPort(kind, port(owner), owner);
      if (owner === 'tree' && !isFileSource(kind)) return false;
      if (kind === 'target' || port(kind) !== (pin.handle === 'exclude' ? 'files' : filePort(pin.handle))) return false;
      if (owner === 'merge' || owner === 'outputtree') return true;
      return !edges.some(edge => edgeTouchesPin(edge, pin, nodes) &&
        (pin.handle !== 'verify' || nodes.find(node => node.id === edge.source)?.data.kind === kind));
    });
  }

  function handleGraphKeys(event: KeyboardEvent<HTMLElement>) {
    const target = event.target;
    if (event.nativeEvent.isComposing || !(target instanceof HTMLElement || target instanceof SVGElement)
      || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === 'a') {
      event.preventDefault();
      selectGraph(true);
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && (key === 'delete' || key === 'backspace')) {
      event.preventDefault();
      deleteSelection();
    } else if (event.altKey && key === 'm') {
      event.preventDefault();
      setMinimap(value => !value);
      setToolMenu(undefined);
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && (key === 'v' || key === 'h')) {
      setCanvasMode(key === 'v' ? 'select' : 'hand');
      setToolMenu(undefined);
    } else if (key === 'escape') {
      if (toolMenu) { setToolMenu(undefined); return; }
      if (menu) { closeMenu(); return; }
      selectGraph(false);
    }
  }

  function replace(next: Workflow, name?: string) {
    previousTreeRoots.current.clear();
    previousDestinations.current = new Map();
    setNodes(next.nodes.map(canvasNode));
    setEdges(next.edges);
    setWorkflowName(name);
  }

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try { await operation(); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setMessage(message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
      setFailed(true);
    } finally { setBusy(false); }
  }

  function updateTask(id: string, change: Partial<QueueTask>) {
    setTasks(items => items.map(item => item.plan.id === id ? { ...item, ...change } : item));
  }

  async function controlTask(id: string, action: 'pause' | 'resume' | 'cancel') {
    if (!await window.filebraid.control(id, action)) return;
    const time = performance.now();
    setTasks(items => items.map(item => {
      if (item.plan.id !== id || item.status !== 'running') return item;
      if (action !== 'resume') return { ...item, control: action === 'pause' ? 'paused' : 'cancelling' };
      const elapsed = item.speedStart === undefined ? 0 : (time - item.speedStart) / 1000;
      return { ...item, control: undefined, progress: new Map([...item.progress].map(([target, event]) =>
        [target, { ...event, time: Math.max(event.time, elapsed) }])) };
    }));
  }

  async function resetTask(item: QueueTask) {
    const plan = await window.filebraid.preview(item.workflow);
    await window.filebraid.removeTask(item.plan.id);
    setTasks(tasks => tasks.map(task => task.plan.id === item.plan.id ? waitingTask(plan, item.workflow, item.name) : task));
    setSelectedTask(id => id === item.plan.id ? plan.id : id);
  }

  async function runTasks(pending: QueueTask[], verifyOnly = false) {
    if (!pending.length || queueRunning) return;
    stopQueue.current = false;
    setQueueRunning(true);
    try {
      for (const item of pending) {
        if (stopQueue.current) break;
        const id = item.plan.id;
        setSelectedTask(id);
        updateTask(id, { status: 'running', message: undefined, verifyOnly, control: undefined });
        try {
          const summary = await window.filebraid.execute(id, verifyOnly);
          const failures = summary.outcomes.filter(outcome => outcome.status === 'failed').length;
          const cancelled = summary.outcomes.filter(outcome => outcome.status === 'cancelled').length;
          const incomplete = [failures ? `${failures} 项失败` : '', cancelled ? `${cancelled} 项已取消` : ''].filter(Boolean).join('，');
          const unverified = summary.outcomes.filter(outcome => outcome.status === 'copied').length;
          updateTask(id, {
            status: cancelled ? 'cancelled' : incomplete ? 'failed' : 'finished',
            outcomes: new Map(summary.outcomes.map(outcome => [outcome.destination, outcome])),
            progress: new Map(), awaitingVerification: new Set(), report: true,
            message: incomplete ? `${incomplete}。`
              : unverified === 0 ? '全部输出已校验。'
              : unverified === summary.outcomes.length ? '复制完成，未校验。' : '复制完成，部分未校验。',
          });
        } catch (cause) {
          updateTask(id, { status: 'failed', progress: new Map(),
            message: String(cause instanceof Error ? cause.message : cause).replace(/^Error invoking remote method '[^']+': Error: /, '') });
        }
      }
    } finally {
      setQueueRunning(false);
    }
  }

  function validConnection(connection: Connection | Edge) {
    const from = nodes.find(entry => entry.id === connection.source)?.data.kind;
    const target = nodes.find(entry => entry.id === connection.target)?.data;
    const to = target?.kind;
    if (!from || !to || connection.source === connection.target || from === 'target') return false;
    if (from === 'camera' && !sonyOutputs.some(output => output.id === (connection.sourceHandle ?? 'out'))) return false;
    const input = port(from);
    const handle = connection.targetHandle ?? input;
    const targetPort = filePort(handle);
    if (!targetPort || !acceptsPort(to, targetPort, from) || input !== (targetPort === 'exclude' ? 'files' : targetPort)) return false;
    if (handle.startsWith('folder:') && (to !== 'outputtree' ||
      !outputFolders(target.value).some(folder => `folder:${folder.id}` === handle))) return false;
    if (handle.startsWith('disk:') && (to !== 'outputtree' || !destinationFolders.get(connection.target))) return false;
    const remainingEdges = edges.filter(edge => edge.id !== reconnecting.current);
    if (from === 'copy' && remainingEdges.some(edge => edge.source === connection.source)) return false;
    const pending = [connection.target];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (id === connection.source) return false;
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...remainingEdges.filter(edge => edge.source === id).map(edge => edge.target));
    }
    return !remainingEdges.some(edge => {
      if (edge.target !== connection.target) return false;
      const existing = nodes.find(entry => entry.id === edge.source)?.data.kind;
      if ((edge.targetHandle ?? port(existing)) !== handle) return false;
      if (to === 'merge' || to === 'outputtree') {
        return edge.source === connection.source && (edge.sourceHandle ?? 'out') === (connection.sourceHandle ?? 'out');
      }
      return targetPort === 'verify' ? existing === from : true;
    });
  }

  const filteredNodes = menu?.type === 'connection'
    ? compatibleNodes(menu.pin).filter(kind => {
      const search = menuSearch.trim().toLowerCase();
      return labels[kind].toLowerCase().includes(search) || kind.includes(search);
    }) : [];
  const connectedCount = menu?.type === 'pin' ? edges.filter(edge => edgeTouchesPin(edge, menu.pin, nodes)).length : 0;
  const menuLeft = menu ? Math.max(8, Math.min(menu.x, window.innerWidth - 238)) : 0;
  const menuDirection = menuLeft + 468 > window.innerWidth && menuLeft >= 235 ? 'left' : 'right';

  return (
    <main>
      <header>
        <div className="app-titlebar">
          <div className="brand"><span aria-hidden="true">▰</span> 织序 FileBraid</div>
        </div>
        <div className="app-toolbar">
          <nav className="actions view-tabs" aria-label="工作区">
            <button aria-pressed={view === 'workflow'} onClick={() => setView('workflow')}>工作流</button>
            <button aria-pressed={view === 'queue'} onClick={() => setView('queue')}>工作队列{waiting.length ? ` (${waiting.length})` : ''}</button>
          </nav>
          {view === 'workflow' && <div className="actions workflow-actions">
            <button disabled={busy} onClick={() => void perform(async () => {
              const job = await window.filebraid.recover();
              if (!job) { setMessage('没有上次任务记录。'); return; }
              replace(decode(job.workflow));
              const status = { finished: '已完成', incomplete: '未全部完成', interrupted: '已中断' }[job.status];
              setMessage(`已载入上次任务（${status}，已记录 ${job.count} 项）。请重新加入队列，复制时会重新校验已有文件。`);
            })}>载入上次任务</button>
          </div>}
          {view === 'workflow' && <button className="primary queue-entry" disabled={busy} aria-busy={busy} onClick={() => void perform(async () => {
              const configured = copyStrategies(workflow.nodes, workflow.edges);
              const copies = workflow.nodes.filter(node => node.kind === 'copy');
              if (copies.some(node => !configured.has(node.id))) {
                throw new Error(`请为每个「${labels.copy}」连接「${labels.standardcopy}」或「${labels.fastcopy}」。`);
              }
              const bound = workflow.edges.filter(edge => copies.some(node => node.id === edge.source));
              if (copies.some(node => !bound.some(edge => edge.source === node.id)) ||
                workflow.nodes.some(node => node.kind === 'target' && !bound.some(edge => edge.target === node.id))) {
                throw new Error(`请将「${labels.copy}」的「输出文件」连接到对应「${labels.target}」的「文件」端口。`);
              }
              const plan = await window.filebraid.preview(workflow);
              setTasks(items => [...items, waitingTask(plan, workflow, workflowName)]);
              setSelectedTask(plan.id);
              setView('queue');
          })}>{busy ? '处理中…' : '加入队列'}</button>}
        </div>
      </header>
      {view === 'workflow' && <>
      <NodeActions.Provider value={{ update, busy, treeFolders: linkedFolders, sonySources, destinationFolders, disconnect: disconnectPin,
        removeFolderConnections: (id, folders) => setEdges(items => items.filter(edge =>
          edge.target !== id || !edge.targetHandle?.startsWith('folder:') || !folders.has(edge.targetHandle.slice(7)))),
        pinMenu: (event, pin) => openMenu(event, { type: 'pin', pin }), chooseDirectory: id => void perform(async () => {
        const path = await window.filebraid.directory();
        if (path) update(id, path);
      }) }}>
      <div className="workspace">
        <aside className="library-sidebar" aria-label="工作流侧栏">
          <nav className="library-tabs" aria-label="侧栏分类">
            <button aria-pressed={library === 'nodes'} onClick={() => setLibrary('nodes')}>节点库</button>
            <button aria-pressed={library === 'workflows'} onClick={() => setLibrary('workflows')}>工作流库</button>
          </nav>
          <div className="library-scroll">
            {library === 'nodes' ? <NodeLibrary add={addNode} /> :
              <WorkflowLibrary busy={busy}
                openWorkflow={() => void perform(async () => {
                  const value = await window.filebraid.open();
                  if (value !== null) replace(decode(value));
                })}
                saveWorkflow={() => void perform(async () => {
                  if (await window.filebraid.save(workflow)) setMessage('工作流已保存。');
                })}
                load={(name, id) => void perform(async () => {
                  const next = id ? decode(await window.filebraid.openLibraryWorkflow(id))
                    : name === sonyWorkflowName ? sonyWorkflow : officialWorkflow;
                  replace(next, name);
                })}
                save={(name, added) => void perform(async () => {
                  const item = await window.filebraid.saveLibraryWorkflow(name, workflow);
                  added(item);
                  setWorkflowName(item.name);
                  setMessage('已存入本机工作流库。');
                })}
                remove={(id, removed) => void perform(async () => {
                  await window.filebraid.removeLibraryWorkflow(id);
                  removed();
                })} />}
          </div>
        </aside>
        <section className="graph" aria-label="工作流画布" onKeyDownCapture={handleGraphKeys}>
          <div className="canvas" ref={canvasRef} tabIndex={0}
            aria-label="左键拖动画布，Ctrl 加左键拖动框选，Delete 删除。"
            onDragOver={event => {
              if (event.dataTransfer.types.includes(nodeDragType)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={event => {
              const kind = event.dataTransfer.getData(nodeDragType);
              if (!Object.hasOwn(labels, kind)) return;
              event.preventDefault();
              addNode(kind as Kind, flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
            }}
            onPointerDownCapture={event => {
              const target = event.target;
              if (event.button === 0 && target instanceof Element
                && !target.closest('input, textarea, select, button, a, [contenteditable], .react-flow__handle')) {
                canvasRef.current?.focus({ preventScroll: true });
              }
            }}>
            <ReactFlow<FlowNode, Edge> className={`${compact ? 'compact-canvas' : ''} ${showLinks ? '' : 'canvas-hide-edges'}`}
              nodes={canvasNodes} edges={canvasEdges} nodeTypes={nodeTypes} onNodesChange={changeNodes} onEdgesChange={changeEdges}
              onInit={instance => { flow.current = instance; }}
              onMove={(_, viewport) => { setCompact(viewport.zoom < 0.35); setCanvasZoom(viewport.zoom); }}
              onNodeClick={(_, node) => setFrontNode(node.id)}
              onNodeDragStart={(_, node) => { closeMenu(); setFrontNode(node.id); }}
              zIndexMode="manual" minZoom={0.08}
              onPaneContextMenu={event => openMenu(event, { type: 'pane' })}
              onNodeContextMenu={(event, node) => {
                setFrontNode(node.id);
                if (!node.selected) {
                  setNodes(items => items.map(item => ({ ...item, selected: item.id === node.id })));
                  setEdges(items => items.map(item => ({ ...item, selected: false })));
                }
                openMenu(event, { type: 'selection' });
              }}
              onEdgeContextMenu={(event, edge) => {
                if (!edge.selected) {
                  setNodes(items => items.map(item => ({ ...item, selected: false })));
                  setEdges(items => items.map(item => ({ ...item, selected: item.id === edge.id })));
                }
                openMenu(event, { type: 'selection' });
              }}
              onSelectionContextMenu={event => openMenu(event, { type: 'selection' })}
              isValidConnection={validConnection}
              onConnect={connection => setEdges(items => addEdge(connection, items))}
              onConnectEnd={(event, state) => {
                if (reconnecting.current || state.isValid || !state.fromNode || !state.fromHandle?.id || !isBlankDrop(event)) return;
                openMenu(event, { type: 'connection', pin: {
                  nodeId: state.fromNode.id, direction: state.fromHandle.type, handle: state.fromHandle.id,
                } });
              }}
              onReconnectStart={(_, edge) => { reconnecting.current = edge.id; }}
              onReconnect={(oldEdge, connection) => setEdges(items => reconnectEdge(oldEdge, connection, items, { shouldReplaceId: false }))}
              onReconnectEnd={(event, edge, _, state) => {
                reconnecting.current = null;
                if (!state.isValid && isBlankDrop(event)) setEdges(items => items.filter(item => item.id !== edge.id));
              }}
              edgesReconnectable reconnectRadius={12} connectOnClick={false}
              selectionMode={SelectionMode.Partial} selectionOnDrag={canvasMode === 'select'} panOnDrag={canvasMode === 'hand' ? [0, 1] : [1]}
              selectionKeyCode="Control" multiSelectionKeyCode={['Shift', 'Meta']}
              selectNodesOnDrag nodeDragThreshold={2} deleteKeyCode={null}
              colorMode="dark" attributionPosition="top-right" fitView fitViewOptions={{ padding: 0.2 }}>
              <Background gap={20} size={1} color="#4d6071" />
              <ViewportPortal>
                {groupBoxes.map(({ group, name, members, box }) => {
                  return <div className="workflow-group nodrag nopan" key={group} style={box} title={`${name} · 拖动标题栏移动，右键重命名`}
                    onPointerDown={event => startGroupDrag(event, members)} onPointerMove={moveGroup}
                    onLostPointerCapture={() => { movingGroup.current = null; }}
                    onContextMenu={event => {
                      event.stopPropagation();
                      setNodes(items => items.map(node => ({ ...node, selected: node.data.group === group })));
                      setEdges(items => items.map(edge => ({ ...edge, selected: false })));
                      openMenu(event, { type: 'selection', groupId: group });
                    }}>
                    <div className="workflow-group-name">{name}</div>
                  </div>;
                })}
              </ViewportPortal>
              {minimap && mapHost && createPortal(<GraphMap nodes={canvasNodes} edges={canvasEdges}
                groups={groupBoxes.map(group => group.box)} options={mapOptions} />, mapHost)}
            </ReactFlow>
          <div className="canvas-tool-dock">
            {minimap && <div className="canvas-map-row">
              {toolMenu === 'map' && <div className="canvas-map-settings" aria-label="小地图图层">
                {([['color', '节点颜色'], ['edges', '显示连接'], ['groups', '显示框架／分组']] as const).map(([key, title]) =>
                  <label key={key}><input type="checkbox" checked={mapOptions[key]}
                    onChange={event => setMapOptions({ ...mapOptions, [key]: event.target.checked })} />{title}</label>)}
                <label title="当前工作流没有节点绕过状态"><input type="checkbox" disabled />渲染绕过状态</label>
                <label title="当前没有节点级错误图层"><input type="checkbox" disabled />渲染错误状态</label>
              </div>}
              <div className="canvas-map-panel">
                <div className="canvas-map-header">
                  <button type="button" aria-label="小地图设置" aria-expanded={toolMenu === 'map'} title="小地图设置"
                    onClick={() => setToolMenu(toolMenu === 'map' ? undefined : 'map')}><CanvasIcon name="settings" /></button>
                  <button type="button" aria-label="关闭小地图" title="关闭小地图" onClick={() => { setMinimap(false); setToolMenu(undefined); }}>
                    <CanvasIcon name="close" /></button>
                </div>
                <div className="canvas-map-host" ref={setMapHost} />
              </div>
            </div>}
            <div className="canvas-tool-row">
              <div className="canvas-status" role="status">{hasSelection
                ? `已选 ${selectedNodes.length} 个节点、${selectedEdges.length} 条连线`
                : canvasMode === 'hand' ? '左键平移 · Ctrl 拖动框选' : '左键框选 · 中键平移'}</div>
              <div className="canvas-toolbar" role="toolbar" aria-label="画布工具">
                {toolMenu === 'mode' && <div className="canvas-tool-popup">
                  <button onClick={() => { setCanvasMode('select'); setToolMenu(undefined); }}><CanvasIcon name="select" />选择<kbd>V</kbd></button>
                  <button onClick={() => { setCanvasMode('hand'); setToolMenu(undefined); }}><CanvasIcon name="hand" />拖拽<kbd>H</kbd></button>
                </div>}
                {toolMenu === 'zoom' && <div className="canvas-tool-popup zoom-popup">
                  {[0.08, 0.25, 0.5, 0.75, 1, 1.5, 2].map(zoom => <button key={zoom} onClick={() => {
                    void flow.current?.zoomTo(zoom, { duration: 180 });
                    setToolMenu(undefined);
                  }}>{Math.round(zoom * 100)}%</button>)}
                </div>}
                <button type="button" className="canvas-tool-mode" aria-label="选择或拖拽" title="选择或拖拽（V／H）"
                  aria-expanded={toolMenu === 'mode'} onClick={() => setToolMenu(toolMenu === 'mode' ? undefined : 'mode')}>
                  <CanvasIcon name={canvasMode} /><CanvasIcon name="chevron" /></button>
                <span className="canvas-tool-divider" />
                <button type="button" aria-label="适配视图" title="适配视图" onClick={() => {
                  void flow.current?.fitView({ padding: 0.2, duration: 180 });
                  setToolMenu(undefined);
                }}><CanvasIcon name="fit" /></button>
                <button type="button" aria-label="缩放比例" aria-expanded={toolMenu === 'zoom'} title="缩放比例"
                  onClick={() => setToolMenu(toolMenu === 'zoom' ? undefined : 'zoom')}>{Math.round(canvasZoom * 100)}% <CanvasIcon name="chevron" /></button>
                <span className="canvas-tool-divider" />
                <button type="button" aria-label="小地图" title="小地图（Alt+M）" aria-pressed={minimap}
                  onClick={() => { setMinimap(value => !value); setToolMenu(undefined); }}><CanvasIcon name="map" /></button>
                <button type="button" aria-label="显示画布连线" title={showLinks ? '隐藏画布连线' : '显示画布连线'} aria-pressed={showLinks}
                  onClick={() => setShowLinks(value => !value)}><CanvasIcon name={showLinks ? 'link' : 'unlink'} /></button>
              </div>
            </div>
          </div>
          </div>
          {menu && <>
            <div className="graph-menu-backdrop" onPointerDown={closeMenu} onContextMenu={event => event.preventDefault()} />
            <div className={`graph-menu menu-opens-${menuDirection}`} ref={menuRef} aria-label="画布右键菜单"
              onKeyDown={event => {
                if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); }
                if (menu.type === 'connection' && event.key === 'Enter' && event.target instanceof HTMLInputElement && filteredNodes.length) {
                  event.preventDefault();
                  addNode(filteredNodes[0], menu.position, menu.pin);
                }
              }}
              style={{ left: menuLeft, top: Math.max(8, Math.min(menu.y, window.innerHeight - 320)) }}>
              {menu.type === 'pane' || menu.type === 'selection' ? <>
                <div className="menu-branch" onMouseEnter={() => setMenuLevel(level => level < 0 ? 0 : level)}>
                  <button aria-expanded={menuLevel >= 0} onClick={() => setMenuLevel(level => Math.max(0, level))}>添加节点 <span className="menu-submenu-arrow" aria-hidden="true" /></button>
                  {menuLevel >= 0 && <div className="graph-menu-subpanel">
                    {nodeGroups.map((group, index) => <div key={group.title} className="menu-branch"
                      onMouseEnter={() => setMenuLevel(index + 1)}>
                      <button aria-expanded={menuLevel === index + 1} onClick={() => setMenuLevel(index + 1)}>
                        {group.title} <span className="menu-submenu-arrow" aria-hidden="true" />
                      </button>
                      {menuLevel === index + 1 && <div className={`graph-menu-subpanel leaf ${(menuDirection === 'right' ? menuLeft + 694 > window.innerWidth : menuLeft < 450) ? 'leaf-flip' : ''}`}>
                        {group.kinds.map(kind => <button key={kind} onClick={() => addNode(kind, menu.position)}>{labels[kind]}</button>)}
                      </div>}
                    </div>)}
                  </div>}
                </div>
                <button onMouseEnter={() => setMenuLevel(-1)} onClick={() => { void flow.current?.fitView(); closeMenu(); }}>适配视图</button>
                <div className="menu-branch graph-organize"
                  onMouseEnter={() => { setMenuLevel(-1); setOrganizeOpen(true); }}
                  onMouseLeave={() => setOrganizeOpen(false)}>
                  <button aria-expanded={organizeOpen} onClick={() => { setMenuLevel(-1); setOrganizeOpen(true); }}>
                    整理 <span className="menu-submenu-arrow" aria-hidden="true" />
                  </button>
                  {organizeOpen && <div className="graph-menu-subpanel organize-actions">
                    <div className="organize-scope">{selectedNodes.length ? '所选节点' : '全部节点'}</div>
                    {([['left', '左对齐'], ['center', '水平居中'], ['right', '右对齐'],
                      ['top', '顶对齐'], ['middle', '垂直居中'], ['bottom', '底对齐']] as const).map(([key, title]) =>
                        <button key={key} disabled={(selectedNodes.length || nodes.length) < 2} onClick={() => alignSelection(key)}>{title}</button>)}
                  </div>}
                </div>
                {menu.groupId && (groupDraft === undefined
                  ? <button onClick={() => setGroupDraft(groupBoxes.find(box => box.group === menu.groupId)?.name ?? menu.groupId)}>重命名组</button>
                  : <form className="group-rename" onSubmit={event => {
                    event.preventDefault();
                    if (menu.groupId) renameGroup(menu.groupId, groupDraft);
                  }}>
                    <label>组名称<input autoFocus value={groupDraft} maxLength={80}
                      onFocus={event => event.target.select()} onChange={event => setGroupDraft(event.target.value)} /></label>
                    <button type="submit" disabled={!groupDraft.trim()}>保存名称</button>
                  </form>)}
                {selectedNodes.length > 1 && <button onClick={() => groupSelection()}>将所选节点建组</button>}
                {selectedNodes.some(node => node.data.group) && <button onClick={() => groupSelection(true)}>将所选节点移出组</button>}
                {hasSelection && <button onClick={() => { deleteSelection(); closeMenu(); }}>
                  {selectedNodes.length === 0 && selectedEdges.length === 1 ? '删除连线'
                    : selectedNodes.length === 1 && selectedEdges.length === 0 ? '删除节点' : '删除所选'}<kbd>Delete</kbd>
                </button>}
              </> : menu.type === 'connection' ? <div className="compatible-menu">
                <div className="graph-menu-title">
                  {portLabel(nodes.find(node => node.id === menu.pin.nodeId)?.data.kind, menu.pin.direction, menu.pin.handle)} · 兼容节点
                </div>
                <input type="search" aria-label="搜索兼容节点" placeholder="搜索兼容节点…" value={menuSearch}
                  onChange={event => setMenuSearch(event.target.value)} />
                {filteredNodes.map(kind => <button key={kind} onClick={() => addNode(kind, menu.position, menu.pin)}>{labels[kind]}</button>)}
                {!filteredNodes.length && <p>没有匹配的兼容节点。</p>}
              </div> : menu.type === 'pin' ? <>
                <div className="pin-connections">
                {edges.filter(edge => edgeTouchesPin(edge, menu.pin, nodes)).map((edge, index) => {
                  const other = nodes.find(node => node.id === (menu.pin.direction === 'source' ? edge.target : edge.source));
                  return <button key={edge.id} title="选中后拖动连线端点" onClick={() => {
                    setEdges(items => items.map(item => ({ ...item, selected: item.id === edge.id })));
                    setNodes(items => items.map(node => ({ ...node, selected: false })));
                    closeMenu();
                  }}>选中连线 {index + 1} · {other ? labels[other.data.kind] : ''}</button>;
                })}
                </div>
                <button disabled={!connectedCount} onClick={() => disconnectPin(menu.pin)}>
                  断开端口连线{connectedCount ? `（${connectedCount}）` : ''}<kbd>Alt + 单击</kbd>
                </button>
                <button onClick={closeMenu}>关闭菜单</button>
              </> : null}
            </div>
          </>}
        </section>
      </div>
      </NodeActions.Provider>
        {message && <p role={failed ? 'alert' : 'status'} className={`workflow-message${failed ? ' error' : ''}`}>{message}</p>}
      </>}
      {view === 'queue' && <div className="queue-view">
        <aside className="queue-list" aria-label="任务列表">
          <div className="queue-list-actions">
            <button className="primary" disabled={busy || queueRunning || !waiting.length} aria-busy={queueRunning}
              onClick={() => void runTasks(waiting)}>运行队列</button>
            {queueRunning && <button onClick={() => {
              stopQueue.current = true;
              void window.filebraid.cancel();
            }}>停止队列</button>}
          </div>
          {tasks.map((item, index) => <button className="queue-item" key={item.plan.id} aria-pressed={item.plan.id === selectedTask}
            onClick={() => setSelectedTask(item.plan.id)}>
            <strong>{item.name || `任务 ${index + 1}`}</strong>
            <span>{item.status === 'running' && item.control ? (item.control === 'paused' ? '已暂停' : '正在取消') : queueLabels[item.status]} · {item.plan.rows.length} 条输出</span>
          </button>)}
          {tasks.length === 0 && <p>在工作流页点击「加入队列」。</p>}
        </aside>
        <section className="preview queue-detail" aria-label="复制任务详情">
          {!task && <p>选择任务以查看文件清单和进度。</p>}
          {task && result && <>
          <h2>任务详情 <small>{result.rows.length} 条输出 / {result.excluded.length} 个文件在至少一条路径被排除</small></h2>
          <div className="actions queue-task-actions">
            {running && <>
              <button className="primary" disabled={busy || task.speedStart === undefined || task.control === 'cancelling'}
                onClick={() => void perform(() => controlTask(result.id, task.control === 'paused' ? 'resume' : 'pause'))}>
                {task.control === 'paused' ? '继续' : '暂停'}</button>
              <button disabled={busy || task.speedStart === undefined || task.control === 'cancelling'}
                onClick={() => void perform(() => controlTask(result.id, 'cancel'))}>取消任务</button>
            </>}
            <button disabled={busy || queueRunning || task.status !== 'waiting'} onClick={() => void runTasks([task])}>开始复制</button>
            <button disabled={busy || queueRunning || task.status !== 'waiting'} onClick={() => void runTasks([task], true)}>仅复验</button>
            {task.status !== 'waiting' && !running && <button disabled={queueRunning || busy}
              onClick={() => void perform(() => resetTask(task))}>重置任务</button>}
            <button disabled={queueRunning || busy} onClick={() => void perform(async () => {
              await window.filebraid.removeTask(result.id);
              setTasks(items => items.filter(item => item.plan.id !== result.id));
              setSelectedTask(tasks.find(item => item.plan.id !== result.id)?.plan.id);
            })}>从队列移除</button>
          </div>
          {task.message && <p role="status" className={task.status === 'failed' ? 'error' : undefined}>{task.message}</p>}
          {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'error' : undefined}>{message}</p>}
          <div className="queue-overview" aria-label="目标与传输速度">
          {(running || task.samples.size > 0 || task.readSamples.size > 0) && <SpeedChart key={result.id}
            samples={task.samples} readSamples={task.readSamples} targets={[...targetCounts.keys()]} duration={duration} progress={progress}
            readOnly={task.verifyOnly === true || result.rows.every(row => row.existing)}
            live={running ? {
              write: [...targetCounts.keys()].reduce((sum, id) => sum + targetSpeed(id, 'write'), 0),
              read: [...targetCounts.keys()].reduce((sum, id) => sum + targetSpeed(id, 'read'), 0),
            } : undefined}
            activity={running ? task.control === 'paused' ? '已暂停' : task.control === 'cancelling' ? '正在取消'
              : [...progress.values()].some(event => event.phase === 'copy') ? '正在复制'
              : [...progress.values()].some(event => event.phase === 'source') ? '正在读取来源，用于复验已有文件'
              : [...progress.values()].some(event => event.phase === 'verify') ? '正在校验目标文件'
              : [...progress.values()].some(event => event.phase === 'flush') ? '正在写入磁盘'
              : '正在准备文件' : undefined} />}
          {targetCounts.size > 0 && <div className="transfer-targets">
            {[...targetCounts].map(([target, count], index) => {
              const current = running ? progress.get(target) : undefined;
              const row = current && result.rows.find(entry => entry.destination === current.destination);
              const writeSpeed = targetSpeed(target, 'write');
              const readSpeed = targetSpeed(target, 'read');
              const lastWrite = task.rates.get(target)?.write;
              return <div className="transfer-target" key={target}>
                <strong title={count.root}>目标 {index + 1} · {count.root}</strong>
                <span>{task.verifyOnly ? '仅复验' : `预览：${count.planned - count.existing} 项待新写入 · ${count.existing} 项已有文件`}</span>
                {running && <span className="live-target-speed">
                  {writeSpeed > 0 ? `复制写入 ${byteSize(writeSpeed)}/s`
                    : lastWrite ? `最近写入 ${byteSize(lastWrite.rate)}/s`
                      : current?.phase === 'copy' ? '写入采样中'
                      : task.verifyOnly || count.planned === count.existing ? '无新写入' : '等待写入'}
                  {current && speedKind(current.phase) === 'read' && ` · 校验读取 ${readSpeed > 0
                    ? byteSize(readSpeed) + '/s' : '采样中'}`}
                </span>}
                <span>{count.succeeded}/{count.planned} 项已完成 · {byteSize(count.completed)} / {byteSize(count.total)}
                  {count.failed ? ` · ${count.failed} 项失败` : ''}{count.cancelled ? ` · ${count.cancelled} 项已取消` : ''}</span>
                <span>总进度 {Math.floor(100 * count.workDone / count.workTotal)}%</span>
                <progress aria-label={`目标 ${index + 1} 总进度`} max={count.workTotal} value={count.workDone} />
                {current && row && <>
                  <span className="transfer-file" title={displayPath(row.source)}>
                    {task.control === 'paused' ? '已暂停' : phases[current.phase]} · {row.source.split(/[\\/]/).at(-1)}
                  </span>
                  <span>{byteSize(Math.min(current.bytes, row.bytes))} / {byteSize(row.bytes)}</span>
                  <progress aria-label={`目标 ${index + 1} 当前文件`} max={row.bytes || 1}
                    value={Math.min(current.bytes, row.bytes)} />
                </>}
              </div>;
            })}
          </div>}
          </div>
          {task.report && !running && <div className="actions">
            {(['html', 'json'] as const).map(format => <button key={format} disabled={busy}
              onClick={() => void window.filebraid.report(result.id, format).catch(cause => {
                setFailed(true);
                setMessage(`报告导出失败：${cause instanceof Error ? cause.message : cause}`);
              })}>导出 {format.toUpperCase()}</button>)}
          </div>}
          <FileStatusGuide />
          <QueueFileList plan={result} activePath={running ? progress.values().next().value?.destination : undefined}
            renderRow={(row, index) => {
                const outcome = outcomes.get(row.destination);
                const current = running ? progress.get(row.target) : undefined;
                const phase = current?.destination === row.destination ? current.phase
                  : running && task.awaitingVerification.has(row.destination) ? 'await_verify' : undefined;
                const state = outcome?.status ?? phase ?? 'pending';
                const active = !outcome && current?.destination === row.destination && current.phase !== 'await_verify' ? current : undefined;
                const percent = active ? active.phase === 'flush' ? 100
                  : row.bytes > 0 ? Math.floor(100 * Math.max(0, Math.min(active.bytes, row.bytes)) / row.bytes) : 0 : undefined;
                const status = outcome ? outcomeLabels[outcome.status]
                  : active && task.control === 'paused' ? '已暂停'
                    : phase ? phases[phase] : row.existing ? '已有文件，待检查' : '待复制';
                const source = outcome?.source_checksums && Object.keys(outcome.source_checksums).length
                  ? outcome.source_checksums : task.sourceHashes.get(row.destination);
                const target = outcome?.target_checksums;
                const algorithm = row.verified_by.find(name => source?.[name] || target?.[name])
                  ?? Object.keys(source ?? target ?? {})[0];
                const comparison = algorithm && source?.[algorithm] && target?.[algorithm]
                  ? source[algorithm] === target[algorithm] ? 'match' : 'mismatch' : undefined;
                return <tr key={row.destination} className="file-list-row" aria-rowindex={index + 2}>
                <td title={displayPath(row.source)}>{displayPath(row.source)}</td><td title={displayPath(row.destination)}>{displayPath(row.destination)}</td>
                <td>{byteSize(row.bytes)}</td><td title={row.copy_settings ? `I/O 块 ${row.copy_settings.block_mib} MiB` : undefined}>
                  {!row.copy_settings ? labels.standardcopy
                    : row.bytes <= Math.max(row.copy_settings.small_file_kib * 1024, row.copy_settings.block_mib * 1024 ** 2) ? '轻量流'
                      : row.copy_mode === 'batch' ? '分批读写'
                        : row.copy_settings.queue_depth === 1 || row.copy_settings.buffer_mib < row.copy_settings.block_mib * 2
                          ? '同步读写' : '并行读写'}
                </td>
                <td title={row.verified_by.join('、')}>{row.verified_by.join('、') || '未选'}
                  {row.verify_timing && <span className="verify-timing-note">{verifyTimingLabels[row.verify_timing]}</span>}
                </td>
                <HashCell sums={source} algorithm={algorithm} label="来源哈希" comparison={comparison} />
                <HashCell sums={target} algorithm={algorithm} label="目标哈希" comparison={comparison} />
                <FileStatus state={state} status={status} percent={percent} error={outcome?.error} />
              </tr>;
            }} />
          {result.excluded.length > 0 && <details className="queue-excluded"><summary>查看排除项</summary>
            <ul>{result.excluded.slice(0, 200).map(path => <li key={path}>{displayPath(path)}</li>)}</ul>
            {result.excluded.length > 200 && <p>显示前 200 项。</p>}
          </details>}
          </>}
        </section>
      </div>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
