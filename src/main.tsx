import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  addEdge, Background, Controls, Handle, Position, ReactFlow, reconnectEdge, SelectionMode, useEdgesState, useNodeConnections, useNodesState, useUpdateNodeInternals,
  type Connection, type Edge, type HandleType, type Node, type NodeProps, type ReactFlowInstance, type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import { speedAxis, timeAxis } from './speed-axis';

const algorithms = {
  crc32: 'CRC32', blake3: 'BLAKE3', md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256', xxh3: 'xxHash3-64',
};
const labels = {
  source: '文件输入', target: '文件输出', tree: '目录树输入', outputtree: '目录树输出',
  camera: 'Sony 卡结构', filter: '扩展名筛选', merge: '清单合并', subtract: '清单相减',
  directory: '目录模板', standardcopy: '标准复制', fastcopy: '快速流复制', ...algorithms,
};
type Kind = keyof typeof labels;
const nodeGroups: { title: string; kinds: Kind[] }[] = [
  { title: '输入与输出', kinds: ['source', 'tree', 'outputtree', 'target'] },
  { title: '整理与筛选', kinds: ['camera', 'directory', 'filter', 'merge', 'subtract'] },
  { title: '复制策略', kinds: ['standardcopy', 'fastcopy'] },
  { title: '校验', kinds: Object.keys(algorithms) as Kind[] },
];
const nodeDragType = 'application/x-cardhelper-node';
const officialWorkflowName = '双目标工作流';
const isAlgorithm = (kind?: Kind) => kind !== undefined && Object.hasOwn(algorithms, kind);
const port = (kind?: Kind) => kind === 'standardcopy' || kind === 'fastcopy' ? 'transfer' : isAlgorithm(kind) ? 'verify' : 'files';
type PortId = 'files' | 'verify' | 'transfer' | 'exclude';
type Pin = { nodeId: string; direction: HandleType; handle: string };
const portLabels = { files: '文件', verify: '校验策略', transfer: '复制策略', exclude: '排除清单' };
function acceptsPort(kind: Kind, input: PortId, from: Kind) {
  if (kind === 'tree') return input === 'files' && from === 'source';
  if (input === 'exclude') return kind === 'subtract';
  return kind === 'target' || (input === 'files' && ['camera', 'filter', 'directory', 'merge', 'subtract', 'outputtree'].includes(kind));
}
function filePort(handle: string): PortId | undefined {
  return handle.startsWith('folder:') || handle.startsWith('disk:') ? 'files' :
    Object.hasOwn(portLabels, handle) ? handle as PortId : undefined;
}
type OutputFolder = { id: string; name: string; parent?: string };
function outputFolders(value: string): OutputFolder[] {
  if (!value) return [];
  try {
    const folders: unknown = JSON.parse(value);
    if (!Array.isArray(folders) || folders.length > 100) return [];
    const known = new Set<string>();
    for (const folder of folders) {
      if (!folder || typeof folder.id !== 'string' || !folder.id || known.has(folder.id) ||
        typeof folder.name !== 'string' || (folder.parent != null && !known.has(folder.parent))) return [];
      known.add(folder.id);
    }
    return folders;
  } catch { return []; }
}
type WorkflowNode = { id: string; kind: Kind; value: string; x: number; y: number };
type Workflow = { version: 3; nodes: WorkflowNode[]; edges: Edge[] };
type LibraryWorkflow = { id: string; name: string; created: string };
function copyStrategies(nodes: WorkflowNode[], edges: Edge[]) {
  const strategyNodes = new Set(nodes.filter(node => port(node.kind) === 'transfer').map(node => node.id));
  return new Set(edges.filter(edge => strategyNodes.has(edge.source) &&
    (edge.sourceHandle ?? 'out') === 'out' && (edge.targetHandle ?? 'transfer') === 'transfer').map(edge => edge.target));
}
type FlowNode = Node<{ kind: Kind; value: string }, 'blueprint'>;
type FolderEntry = { name: string; directory: boolean };
function treeInputs(nodes: FlowNode[], edges: Edge[]) {
  const sources = new Map(nodes.filter(node => node.data.kind === 'source').map(node => [node.id, node.data.value]));
  return new Map(edges.flatMap(edge => sources.has(edge.source) && (edge.targetHandle ?? 'files') === 'files'
    ? [[edge.target, sources.get(edge.source)!] as const] : []));
}
function treeDestinations(nodes: FlowNode[], edges: Edge[]) {
  const targets = new Map(nodes.filter(node => node.data.kind === 'target').map(node => [node.id, node.data.value]));
  const roots = new Map<string, string>();
  for (const node of nodes) {
    if (node.data.kind !== 'outputtree') continue;
    const outgoing = edges.filter(edge => edge.source === node.id);
    if (outgoing.length === 1) {
      const target = targets.get(outgoing[0].target);
      if (target !== undefined) roots.set(node.id, target);
    }
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
type Outcome = { destination: string; target: string; status: 'verified' | 'reused' | 'copied' | 'failed' | 'cancelled'; error: string | null; retried: boolean; checksums: Record<string, string> };
type CopyProgress = { kind: 'progress'; destination: string; target: string; phase: 'source' | 'copy' | 'flush' | 'verify'; bytes: number; bytes_per_second: number };
const phases = { source: '读取来源', copy: '复制中', flush: '写入磁盘', verify: '校验目标' };
type SpeedSample = { time: number; speed: number };
type QueueTask = {
  plan: Plan; workflow: Workflow; status: 'waiting' | 'running' | 'finished' | 'failed' | 'cancelled';
  name?: string;
  outcomes: Map<string, Outcome>; progress: Map<string, CopyProgress>; samples: Map<string, SpeedSample[]>;
  message?: string; report?: boolean;
  speedStart?: number; speedElapsed?: number;
};
const queueLabels = { waiting: '待执行', running: '运行中', finished: '已完成', failed: '未完成', cancelled: '已停止' };
const chartColors = ['#79c9bc', '#f4ca7c', '#adbbeb', '#e7a99f'];
function byteSize(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = bytes >= 1 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
const outcomeLabels = {
  verified: '校验通过', reused: '校验后复用', copied: '复制完成，未校验', failed: '失败', cancelled: '已中止',
};
declare global {
  interface Window {
    cardhelper: {
      directory(): Promise<string | null>;
      directoryItems(folder: string, relative: string): Promise<FolderEntry[]>;
      open(): Promise<unknown>;
      save(workflow: Workflow): Promise<boolean>;
      listLibraryWorkflows(): Promise<LibraryWorkflow[]>;
      openLibraryWorkflow(id: string): Promise<unknown>;
      saveLibraryWorkflow(name: string, workflow: Workflow): Promise<LibraryWorkflow>;
      removeLibraryWorkflow(id: string): Promise<void>;
      preview(workflow: Workflow): Promise<Plan>;
      execute(id: string, verifyOnly?: boolean): Promise<{ outcomes: Outcome[] } | null>;
      removeTask(id: string): Promise<void>;
      cancel(): Promise<void>;
      recover(): Promise<{ workflow: unknown; status: 'finished' | 'incomplete' | 'interrupted'; date: string; count: number } | null>;
      clearRecovery(): Promise<void>;
      report(id: string, format: 'html' | 'json'): Promise<boolean>;
      onProgress(callback: (id: string, event: Outcome | CopyProgress) => void): () => void;
    };
  }
}

const officialWorkflow: Workflow = {
  version: 3,
  nodes: [
    { id: 'source', kind: 'source', value: '', x: 0, y: 30 },
    { id: 'camera', kind: 'camera', value: '', x: 285, y: 30 },
    { id: 'directory', kind: 'directory', value: '项目/A机/卡001', x: 570, y: 30 },
    { id: 'a', kind: 'target', value: '', x: 905, y: 0 },
    { id: 'b', kind: 'target', value: '', x: 905, y: 235 },
    { id: 'sha256', kind: 'sha256', value: '', x: 570, y: 365 },
    { id: 'standardcopy', kind: 'standardcopy', value: '', x: 285, y: 365 },
  ],
  edges: [
    ['source', 'camera'], ['camera', 'directory'], ['directory', 'a'],
    ['directory', 'b'], ['sha256', 'a'], ['sha256', 'b'], ['standardcopy', 'a'], ['standardcopy', 'b'],
  ].map(([source, target]) => ({ id: source + ':' + target, source, target })),
};

function canvasNode(node: WorkflowNode): FlowNode {
  return {
    id: node.id,
    type: 'blueprint',
    dragHandle: '.node-title',
    position: { x: node.x, y: node.y },
    data: { kind: node.kind, value: node.value },
    className: port(node.kind) !== 'files' ? 'kind-algorithm' : 'kind-' + node.kind,
  };
}

const NodeActions = createContext<{
  update(id: string, value: string): void;
  chooseDirectory(id: string): void;
  busy: boolean;
  treeFolders: ReadonlyMap<string, string>;
  destinationFolders: ReadonlyMap<string, string>;
  removeFolderConnections(id: string, folders: ReadonlySet<string>): void;
  pinMenu(event: MouseEvent, pin: Pin): void;
  disconnect(pin: Pin): void;
} | null>(null);

function DirectoryTree({ value, update }: { value: string; update(value: string): void }) {
  const parts = value.split('/');

  function move(index: number, offset: number) {
    const next = [...parts];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    update(next.join('/'));
  }

  function branch(index: number): React.ReactNode {
    const part = parts[index];
    return <li>
      <div className="tree-row">
        <span className="folder-icon" aria-hidden="true" />
        <input aria-label={`第 ${index + 1} 层文件夹`} value={part} placeholder="文件夹名"
          onChange={event => {
            if (!event.target.value.includes('/')) {
              update(parts.map((name, i) => i === index ? event.target.value : name).join('/'));
            }
          }} />
        <button title="上移一层" aria-label={`上移第 ${index + 1} 层`} disabled={index === 0}
          onClick={() => move(index, -1)}>↑</button>
        <button title="移除这一层" aria-label={`移除第 ${index + 1} 层`}
          onClick={() => update(parts.filter((_, i) => i !== index).join('/'))}>×</button>
      </div>
      {index + 1 < parts.length && <ul>{branch(index + 1)}</ul>}
    </li>;
  }

  return <div className="folder-tree">
    <div className="tree-root"><span className="folder-icon" aria-hidden="true" /> 目标根目录</div>
    <ul aria-label="目录模板文件夹树">{branch(0)}</ul>
    <button onClick={() => update(value ? value + '/新目录' : '新目录')}>＋ 添加子文件夹</button>
  </div>;
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
    window.cardhelper.directoryItems(folder, relative).then(
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

  function branch(parent?: string, depth = 0): React.ReactNode {
    return folders.filter(folder => (folder.parent ?? undefined) === parent).map(folder =>
      <li key={folder.id}>
        <div className="target-tree-row node-port">
          {input(`folder:${folder.id}`, folder.name || '未命名文件夹')}
          <div className="tree-row" style={{ marginInlineStart: Math.min(depth, 8) * 9 }}>
            <span className="folder-icon" aria-hidden="true" />
            <input aria-label="目标文件夹名称" value={folder.name} placeholder="文件夹名"
              onChange={event => save(folders.map(item => item.id === folder.id ? { ...item, name: event.target.value } : item))} />
            <button type="button" disabled={folders.length >= 100} title="添加子文件夹" aria-label={`在 ${folder.name} 中添加子文件夹`}
              onClick={() => add(folder.id)}>＋</button>
            <button type="button" title="移除此文件夹及其子项的连线" aria-label={`移除 ${folder.name}`}
              onClick={() => remove(folder.id)}>×</button>
          </div>
        </div>
        {folders.some(item => item.parent === folder.id) && <ul>{branch(folder.id, depth + 1)}</ul>}
      </li>);
  }

  return <div className="target-tree">
    {folders.length > 0 && <div className="node-field">规划目录</div>}
    {folders.length > 0 && <ul aria-label="目标目录树">{branch()}</ul>}
    <button type="button" disabled={folders.length >= 100} onClick={() => add()}>添加规划文件夹</button>
  </div>;
}

function BlueprintNode({ id, data }: NodeProps<FlowNode>) {
  const actions = useContext(NodeActions)!;
  const { kind, value } = data;
  const strategy = port(kind);
  const policy = strategy !== 'files';
  const isPath = kind === 'source' || kind === 'tree' || kind === 'target';
  const linked = kind === 'tree' && actions.treeFolders.has(id);
  const folder = linked ? actions.treeFolders.get(id)! : value;
  const destination = actions.destinationFolders.get(id);
  const exclude = value.startsWith('exclude:');
  function pinProps(direction: HandleType, handle: string) {
    const pin = { nodeId: id, direction, handle };
    return {
      title: direction === 'source' ? '输出端口 · 拖到空白处添加兼容节点' : '输入端口 · 右键查看连接',
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
  const mainOutput = <div className={`node-port node-port-output ${strategy === 'transfer' ? 'transfer' : policy ? 'policy' : ''}`}>
    {policy ? portLabels[strategy] : kind === 'tree' ? '全部文件输出' : kind === 'outputtree' ? '汇总文件输出' : '文件输出'}
    <Handle id="out" type="source" position={Position.Right} {...pinProps('source', 'out')} />
  </div>;
  return <>
    <div className="node-title">{labels[kind]}</div>
    <div className="node-ports">
      {kind === 'outputtree' && mainOutput}
      {kind !== 'source' && !policy && <div className="node-port">
        <Handle id="files" type="target" position={Position.Left} {...pinProps('target', 'files')}
          title={kind === 'tree' ? '连接「文件输入」以读取来源根目录'
            : kind === 'outputtree' ? '接收直接复制到目标根目录的文件' : '输入端口 · 右键查看连接'} />
        {kind === 'merge' ? '清单输入（可多连）' : kind === 'subtract' ? '主清单' : kind === 'tree' ? '来源根目录输入' : kind === 'outputtree' ? '全部文件输入' : '文件输入'}
      </div>}
      {kind === 'subtract' && <div className="node-port">
        <Handle id="exclude" type="target" position={Position.Left} {...pinProps('target', 'exclude')} /> 排除清单
      </div>}
      {kind === 'target' && <div className="node-port policy">
        <Handle id="verify" type="target" position={Position.Left} {...pinProps('target', 'verify')} /> 校验策略
      </div>}
      {kind === 'target' && <div className="node-port transfer">
        <Handle id="transfer" type="target" position={Position.Left} {...pinProps('target', 'transfer')} /> 复制策略
      </div>}
      {kind !== 'target' && kind !== 'outputtree' && mainOutput}
    </div>
    <div className="node-body nodrag nowheel" onClick={event => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, button, a, [contenteditable]')) {
        event.stopPropagation();
      }
    }}>
      {isPath && <>
        <div className="node-field">{kind === 'target' ? '目标目录' : linked ? '已连接的来源目录' : '来源目录'}</div>
        <div className="path" title={folder}>{folder || (linked ? '请在上游「文件输入」选择目录' : '尚未选择目录')}</div>
        {!linked && <button disabled={actions.busy} onClick={() => actions.chooseDirectory(id)}>选择文件夹</button>}
      </>}
      {kind === 'tree' && folder && <DiskTree key={folder} id={id} folder={folder} direction="source" handle={relative => {
        const handle = `item:${relative}`;
        return <Handle id={handle} type="source" position={Position.Right} {...pinProps('source', handle)}
          aria-label={`输出 ${relative}`} title={`拖动以输出 ${relative}`} />;
      }} />}
      {kind === 'directory' && <DirectoryTree value={value} update={next => actions.update(id, next)} />}
      {kind === 'outputtree' && <>
        <div className="node-field">输出目录</div>
        {destination ? <>
          <div className="path" title={destination}>{destination}</div>
          <DiskTree key={destination} id={id} folder={destination} direction="target" handle={relative =>
            <Handle id={`disk:${relative}`} type="target" position={Position.Left} {...pinProps('target', `disk:${relative}`)}
              aria-label={`输入到 ${relative}`} title={`输入到 ${relative}`} />
          } />
        </> : <span className="node-note">连接一个已选择目录的「文件输出」即可展开。</span>}
        <TargetTree id={id} value={value} input={(handle, name) =>
          <Handle id={handle} type="target" position={Position.Left} {...pinProps('target', handle)}
            aria-label={`输入到 ${name}`} title={`输入到 ${name}`} />
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
      {kind === 'subtract' && <span className="node-note">从主清单排除另一条线指定的源文件，按源路径匹配。</span>}
      {kind === 'camera' && <>
        <div className="node-field">目录识别</div>
        <div>Sony SD / CFexpress</div>
        <span className="node-note">识别照片、视频和代理，保留未知文件</span>
      </>}
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
    </div>
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
  if (!data || (data.version !== 1 && data.version !== 2 && data.version !== 3) || !Array.isArray(data.nodes) || !Array.isArray(data.edges)
    || data.nodes.length > (data.version === 1 ? 100 : 101) || data.edges.length > (data.version === 1 ? 200 : 300)) {
    throw new Error('不支持此工作流格式。');
  }
  if (!data.nodes.every(node => node && typeof node.id === 'string'
    && Object.hasOwn(labels, node.kind) && typeof node.value === 'string'
    && Number.isFinite(node.x) && Number.isFinite(node.y))
    || new Set(data.nodes.map(node => node.id)).size !== data.nodes.length
    || !data.edges.every(edge => edge && typeof edge.id === 'string'
      && typeof edge.source === 'string' && typeof edge.target === 'string'
      && (edge.sourceHandle == null || typeof edge.sourceHandle === 'string')
      && (edge.targetHandle == null || typeof edge.targetHandle === 'string'))) {
    throw new Error('工作流含无效节点或连线。');
  }
  const nodes = data.nodes.map(({ id, kind, value, x, y }) => ({ id, kind, value, x, y }));
  const edges = data.edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle }));
  if (data.version < 3) {
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
  if (data.version === 1) {
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
  return { version: 3, nodes, edges };
}

function SpeedChart({ samples, targets, elapsed }: { samples: Map<string, SpeedSample[]>; targets: string[]; elapsed: number }) {
  const { start, end, step: secondsStep } = timeAxis(elapsed);
  const series = targets.map(target => (samples.get(target) ?? []).filter(point => point.time >= start));
  const peak = Math.max(0, ...series.flatMap(values => values.map(point => point.speed)));
  const { maximum, step: speedStep, unit } = speedAxis(peak);
  const ticks = [0, 1, 2, 3, 4];
  const x = (time: number) => (time - start) / (end - start) * 720;
  const y = (speed: number) => 124 - speed / maximum * 124;
  return <figure className="speed-chart">
    <figcaption><strong>复制速度</strong><span>{start > 0 ? '最近 60 秒' : '本次任务'}{peak > 0 ? ` · 峰值 ${byteSize(peak)}/s` : ''}</span></figcaption>
    <div className="speed-axes">
      <span className="speed-unit">{unit}</span>
      <div className="speed-y" aria-hidden="true">{[...ticks].reverse().map(tick =>
        <span key={tick} style={{ top: `${100 - tick * 25}%` }}>{(tick * speedStep).toLocaleString('zh-CN', { maximumFractionDigits: 3 })}</span>)}</div>
      <svg viewBox="0 0 720 124" preserveAspectRatio="none" role="img" aria-label="各目标实时写入速度">
        {ticks.map(tick => <line key={tick} x1="0" x2="720" y1={tick * 31} y2={tick * 31} className="chart-grid" />)}
        {series.map((values, i) => {
          const color = chartColors[i % chartColors.length];
          return values.map((point, index) => {
            const previous = values[index - 1];
            return previous && point.time - previous.time <= 1
              ? <line key={index} x1={x(previous.time)} y1={y(previous.speed)} x2={x(point.time)} y2={y(point.speed)}
                stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
              : <circle key={index} cx={x(point.time)} cy={y(point.speed)} r="2" fill={color} />;
          });
        })}
      </svg>
      <div className="speed-x" aria-hidden="true">{ticks.map(tick =>
        <span key={tick} style={{ left: `${tick * 25}%` }}>{Number((start + tick * secondsStep).toFixed(3))} 秒</span>)}</div>
    </div>
    {peak === 0 && <p className="speed-empty">暂无复制速度样本</p>}
    <div className="chart-legend">{targets.map((target, i) => <span key={target}>
      <i style={{ background: chartColors[i % chartColors.length] }} />目标 {i + 1}
    </span>)}</div>
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
    window.cardhelper.listLibraryWorkflows().then(
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

type GraphMenu = { x: number; y: number; position: XYPosition } &
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
  const [menuSearch, setMenuSearch] = useState('');
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
  const outcomes = task?.outcomes ?? new Map<string, Outcome>();
  const progress = task?.progress ?? new Map<string, CopyProgress>();
  const waiting = tasks.filter(item => item.status === 'waiting');
  const selectedNodes = nodes.filter(node => node.selected);
  const selectedEdges = edges.filter(edge => edge.selected);
  const hasSelection = selectedNodes.length + selectedEdges.length > 0;
  const linkedFolders = useMemo(() => treeInputs(nodes, edges), [nodes, edges]);
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
  useEffect(() => window.cardhelper.onProgress((id, event) => {
    const time = performance.now();
    setTasks(previous => previous.map(item => {
      if (item.plan.id !== id) return item;
      const speedStart = item.speedStart ?? time;
      const speedElapsed = (time - speedStart) / 1000;
      const progress = new Map(item.progress);
      const samples = new Map(item.samples);
      const speed = 'kind' in event && event.phase === 'copy' ? event.bytes_per_second : 0;
      const points = samples.get(event.target) ?? [];
      if (Number.isFinite(speed) && speed > 0) {
        samples.set(event.target, [...points.filter(point => point.time >= speedElapsed - 60).slice(-349), { time: speedElapsed, speed }]);
      }
      if ('kind' in event) {
        progress.set(event.target, event);
        return { ...item, progress, samples, speedStart, speedElapsed };
      }
      if (progress.get(event.target)?.destination === event.destination) progress.delete(event.target);
      return { ...item, progress, samples, speedStart, speedElapsed, outcomes: new Map(item.outcomes).set(event.destination, event) };
    }));
  }), []);
  const canvasEdges: Edge[] = edges.map(edge => {
    const input = port(nodes.find(entry => entry.id === edge.source)?.data.kind);
    return {
      ...edge,
      sourceHandle: edge.sourceHandle ?? 'out',
      targetHandle: edge.targetHandle ?? input,
      interactionWidth: 26,
      style: input === 'files' ? { stroke: '#79c9bc' } :
        { stroke: input === 'transfer' ? '#e7ac73' : '#adbbeb', strokeDasharray: '5 4' },
    };
  });
  const workflow: Workflow = {
    version: 3,
    nodes: nodes.map(entry => ({
      id: entry.id, kind: entry.data.kind, value: entry.data.value, x: entry.position.x, y: entry.position.y,
    })),
    edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle })),
  };
  const targetCounts = new Map<string, { planned: number; processed: number; failures: number; total: number; completed: number; root: string }>();
  for (const row of result?.rows ?? []) {
    const count = targetCounts.get(row.target) ?? { planned: 0, processed: 0, failures: 0, total: 0, completed: 0,
      root: task?.workflow.nodes.find(node => node.id === row.target)?.value ?? row.target };
    count.planned++;
    count.total += row.bytes;
    const outcome = outcomes.get(row.destination);
    if (outcome) {
      count.processed++;
      if (outcome.status === 'failed' || outcome.status === 'cancelled') count.failures++;
      else count.completed += row.bytes;
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

  function openMenu(event: MouseEvent | globalThis.MouseEvent | TouchEvent, action: Pick<GraphMenu, 'type'> & { pin?: Pin }) {
    if (event.cancelable) event.preventDefault();
    const bounds = canvasRef.current?.getBoundingClientRect();
    const cursor = eventPoint(event);
    const x = cursor?.x || (bounds ? bounds.left + bounds.width / 2 : 0);
    const y = cursor?.y || (bounds ? bounds.top + bounds.height / 2 : 0);
    const position = flow.current?.screenToFlowPosition({ x, y }) ?? { x: 0, y: 0 };
    setMenuLevel(-1);
    setMenuSearch('');
    if (action.type === 'pane' || action.type === 'selection') setMenu({ x, y, position, type: action.type });
    else if (action.pin) setMenu({ x, y, position, type: action.type, pin: action.pin });
  }

  function disconnectPin(pin: Pin) {
    setEdges(items => items.filter(edge => !edgeTouchesPin(edge, pin, nodes)));
    closeMenu();
  }

  function compatibleNodes(pin: Pin) {
    const owner = nodes.find(node => node.id === pin.nodeId)?.data.kind;
    if (!owner) return [];
    return nodeGroups.flatMap(group => group.kinds).filter(kind => {
      if (pin.direction === 'source') return acceptsPort(kind, port(owner), owner);
      if (owner === 'tree' && kind !== 'source') return false;
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
    } else if (key === 'escape') {
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

  async function runTasks(pending: QueueTask[], verifyOnly = false) {
    if (!pending.length || queueRunning) return;
    stopQueue.current = false;
    setQueueRunning(true);
    try {
      for (const item of pending) {
        if (stopQueue.current) break;
        const id = item.plan.id;
        setSelectedTask(id);
        updateTask(id, { status: 'running', message: undefined });
        try {
          const summary = await window.cardhelper.execute(id, verifyOnly);
          if (!summary) {
            updateTask(id, { status: 'waiting' });
            break;
          }
          const incomplete = summary.outcomes.filter(outcome => outcome.status === 'failed' || outcome.status === 'cancelled').length;
          const cancelled = summary.outcomes.some(outcome => outcome.status === 'cancelled');
          const unverified = summary.outcomes.filter(outcome => outcome.status === 'copied').length;
          updateTask(id, {
            status: cancelled ? 'cancelled' : incomplete ? 'failed' : 'finished',
            outcomes: new Map(summary.outcomes.map(outcome => [outcome.destination, outcome])),
            progress: new Map(), report: true,
            message: incomplete ? `${incomplete} 条输出失败或中止。`
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
    if (!from || !to || connection.source === connection.target || from === 'target' || to === 'source' || port(to) !== 'files') return false;
    const input = port(from);
    const handle = connection.targetHandle ?? input;
    const targetPort = filePort(handle);
    if (!targetPort || !acceptsPort(to, targetPort, from) || input !== (targetPort === 'exclude' ? 'files' : targetPort)) return false;
    if (handle.startsWith('folder:') && (to !== 'outputtree' ||
      !outputFolders(target.value).some(folder => `folder:${folder.id}` === handle))) return false;
    if (handle.startsWith('disk:') && (to !== 'outputtree' || !destinationFolders.get(connection.target))) return false;
    const remainingEdges = edges.filter(edge => edge.id !== reconnecting.current);
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
          <div className="brand"><span aria-hidden="true">▰</span> CardHelper</div>
        </div>
        <div className="app-toolbar">
          <nav className="actions view-tabs" aria-label="工作区">
            <button aria-pressed={view === 'workflow'} onClick={() => setView('workflow')}>工作流</button>
            <button aria-pressed={view === 'queue'} onClick={() => setView('queue')}>工作队列{waiting.length ? ` (${waiting.length})` : ''}</button>
          </nav>
          {view === 'workflow' && <div className="actions workflow-actions">
            <button disabled={busy} onClick={() => void perform(async () => {
              const job = await window.cardhelper.recover();
              if (!job) { setMessage('没有上次任务记录。'); return; }
              replace(decode(job.workflow));
              const status = { finished: '已完成', incomplete: '未全部完成', interrupted: '已中断' }[job.status];
              setMessage(`已载入上次任务（${status}，已记录 ${job.count} 项）。请重新加入队列，复制时会重新校验已有文件。`);
            })}>载入上次任务</button>
          </div>}
          {view === 'workflow' && <button className="primary queue-entry" disabled={busy} onClick={() => void perform(async () => {
              const configured = copyStrategies(workflow.nodes, workflow.edges);
              const missing = workflow.nodes.filter(node => node.kind === 'target' && !configured.has(node.id));
              if (missing.length) {
                throw new Error(`有 ${missing.length} 个「文件输出」未连接复制策略。请连接「标准复制」或「快速流复制」。`);
              }
              const plan = await window.cardhelper.preview(workflow);
              setTasks(items => [...items, { plan, workflow, name: workflowName, status: 'waiting', outcomes: new Map(), progress: new Map(), samples: new Map() }]);
              setSelectedTask(plan.id);
              setView('queue');
          })}>{busy ? '处理中…' : '加入队列'}</button>}
        </div>
      </header>
      {view === 'workflow' && <>
      <NodeActions.Provider value={{ update, busy, treeFolders: linkedFolders, destinationFolders, disconnect: disconnectPin,
        removeFolderConnections: (id, folders) => setEdges(items => items.filter(edge =>
          edge.target !== id || !edge.targetHandle?.startsWith('folder:') || !folders.has(edge.targetHandle.slice(7)))),
        pinMenu: (event, pin) => openMenu(event, { type: 'pin', pin }), chooseDirectory: id => void perform(async () => {
        const path = await window.cardhelper.directory();
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
                  const value = await window.cardhelper.open();
                  if (value !== null) {
                    const opened = decode(value);
                    await window.cardhelper.clearRecovery();
                    replace(opened);
                  }
                })}
                saveWorkflow={() => void perform(async () => {
                  if (await window.cardhelper.save(workflow)) setMessage('工作流已保存。');
                })}
                load={(name, id) => void perform(async () => {
                  const next = id ? decode(await window.cardhelper.openLibraryWorkflow(id)) : officialWorkflow;
                  await window.cardhelper.clearRecovery();
                  replace(next, name);
                })}
                save={(name, added) => void perform(async () => {
                  const item = await window.cardhelper.saveLibraryWorkflow(name, workflow);
                  added(item);
                  setWorkflowName(item.name);
                  setMessage('已存入本机工作流库。');
                })}
                remove={(id, removed) => void perform(async () => {
                  await window.cardhelper.removeLibraryWorkflow(id);
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
            <ReactFlow nodes={nodes} edges={canvasEdges} nodeTypes={nodeTypes} onNodesChange={changeNodes} onEdgesChange={changeEdges}
              onInit={instance => { flow.current = instance; }}
              onPaneContextMenu={event => openMenu(event, { type: 'pane' })}
              onNodeContextMenu={(event, node) => {
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
              selectionMode={SelectionMode.Partial} panOnDrag={[0, 1]}
              selectionKeyCode="Control" multiSelectionKeyCode={['Shift', 'Meta']}
              selectNodesOnDrag={false} deleteKeyCode={null}
              colorMode="dark" fitView fitViewOptions={{ padding: 0.2 }}>
              <Background gap={20} size={1} color="#4d6071" />
              <Controls showInteractive={false} />
            </ReactFlow>
            <div className="canvas-status" role="status">{hasSelection
              ? `已选 ${selectedNodes.length} 个节点、${selectedEdges.length} 条连线`
              : '左键平移 · Ctrl 拖动框选 · 右键菜单'}</div>
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
              style={{ left: menuLeft, top: Math.max(8, Math.min(menu.y, window.innerHeight -
                (menu.type === 'connection' ? 320 : menu.type === 'pane' ? 260 : 105))) }}>
              {menu.type === 'pane' ? <>
                <div className="menu-branch" onMouseEnter={() => setMenuLevel(level => level < 0 ? 0 : level)}>
                  <button aria-expanded={menuLevel >= 0} onClick={() => setMenuLevel(level => Math.max(0, level))}>添加节点 <kbd>›</kbd></button>
                  {menuLevel >= 0 && <div className="graph-menu-subpanel">
                    {nodeGroups.map((group, index) => <div key={group.title} className="menu-branch"
                      onMouseEnter={() => setMenuLevel(index + 1)}>
                      <button aria-expanded={menuLevel === index + 1} onClick={() => setMenuLevel(index + 1)}>
                        {group.title} <kbd>›</kbd>
                      </button>
                      {menuLevel === index + 1 && <div className={`graph-menu-subpanel leaf ${(menuDirection === 'right' ? menuLeft + 694 > window.innerWidth : menuLeft < 450) ? 'leaf-flip' : ''}`}>
                        {group.kinds.map(kind => <button key={kind} onClick={() => addNode(kind, menu.position)}>{labels[kind]}</button>)}
                      </div>}
                    </div>)}
                  </div>}
                </div>
                <button onMouseEnter={() => setMenuLevel(-1)} onClick={() => { void flow.current?.fitView(); closeMenu(); }}>适配视图</button>
              </> : menu.type === 'connection' ? <div className="compatible-menu">
                <div className="graph-menu-title">
                  {portLabels[menu.pin.direction === 'target' ? filePort(menu.pin.handle) ?? 'files' : port(nodes.find(node => node.id === menu.pin.nodeId)?.data.kind)]} · 兼容节点
                </div>
                <input type="search" aria-label="搜索兼容节点" placeholder="搜索兼容节点…" value={menuSearch}
                  onChange={event => setMenuSearch(event.target.value)} />
                {filteredNodes.map(kind => <button key={kind} onClick={() => addNode(kind, menu.position, menu.pin)}>{labels[kind]}</button>)}
                {!filteredNodes.length && <p>没有匹配的兼容节点。</p>}
              </div> : menu.type === 'pin' ? <>
                <button disabled={!connectedCount} onClick={() => disconnectPin(menu.pin)}>
                  断开端口连线{connectedCount ? `（${connectedCount}）` : ''}<kbd>Alt + 单击</kbd>
                </button>
                <button onClick={closeMenu}>关闭菜单</button>
              </> : <button disabled={!hasSelection} onClick={() => { deleteSelection(); closeMenu(); }}>
                {selectedNodes.length === 0 && selectedEdges.length === 1 ? '删除连线'
                  : selectedNodes.length === 1 && selectedEdges.length === 0 ? '删除节点' : '删除所选'}
                <kbd>Delete</kbd>
              </button>}
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
            <button className="primary" disabled={queueRunning || !waiting.length}
              onClick={() => void runTasks(waiting)}>运行队列</button>
            {queueRunning && <button onClick={() => {
              stopQueue.current = true;
              void window.cardhelper.cancel();
            }}>停止队列</button>}
          </div>
          {tasks.map((item, index) => <button className="queue-item" key={item.plan.id} aria-pressed={item.plan.id === selectedTask}
            onClick={() => setSelectedTask(item.plan.id)}>
            <strong>{item.name || `任务 ${index + 1}`}</strong>
            <span>{queueLabels[item.status]} · {item.plan.rows.length} 条输出</span>
          </button>)}
          {tasks.length === 0 && <p>在工作流页点击「加入队列」。</p>}
        </aside>
        <section className="preview queue-detail" aria-label="复制任务详情">
          {!task && <p>选择任务以查看文件清单和进度。</p>}
          {task && result && <>
          <h2>任务详情 <small>{result.rows.length} 条输出 / {result.excluded.length} 个文件在至少一条路径被排除</small></h2>
          <div className="actions queue-task-actions">
            <button disabled={queueRunning || task.status !== 'waiting'} onClick={() => void runTasks([task])}>开始复制</button>
            <button disabled={queueRunning || task.status !== 'waiting'} onClick={() => void runTasks([task], true)}>仅复验</button>
            <button disabled={queueRunning} onClick={() => void perform(async () => {
              await window.cardhelper.removeTask(result.id);
              setTasks(items => items.filter(item => item.plan.id !== result.id));
              setSelectedTask(tasks.find(item => item.plan.id !== result.id)?.plan.id);
            })}>从队列移除</button>
          </div>
          {task.message && <p role="status" className={task.status === 'failed' ? 'error' : undefined}>{task.message}</p>}
          {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'error' : undefined}>{message}</p>}
          {(running || task.samples.size > 0) && <SpeedChart samples={task.samples} targets={[...targetCounts.keys()]} elapsed={task.speedElapsed ?? 0} />}
          {(running || outcomes.size > 0) && <div className="transfer-targets">
            {[...targetCounts].map(([target, count], index) => {
              const current = running ? progress.get(target) : undefined;
              const row = current && result.rows.find(entry => entry.destination === current.destination);
              return <div className="transfer-target" key={target}>
                <strong title={count.root}>目标 {index + 1} · {count.root}</strong>
                <span>{count.processed}/{count.planned} 项 · {byteSize(count.completed)} / {byteSize(count.total)}
                  {count.failures ? ` · ${count.failures} 项未完成` : ''}</span>
                <progress aria-label={`目标 ${index + 1} 已处理文件`} max={count.planned} value={count.processed} />
                {current && row && <>
                  <span className="transfer-file" title={row.source}>
                    {phases[current.phase]} · {row.source.split(/[\\/]/).at(-1)}
                  </span>
                  <span>{byteSize(Math.min(current.bytes, row.bytes))} / {byteSize(row.bytes)}
                    {current.bytes_per_second > 0 ? ` · ${byteSize(current.bytes_per_second)}/s` : ''}</span>
                  <progress aria-label={`目标 ${index + 1} 当前文件`} max={row.bytes || 1}
                    value={Math.min(current.bytes, row.bytes)} />
                </>}
              </div>;
            })}
          </div>}
          {task.report && !running && <div className="actions">
            {(['html', 'json'] as const).map(format => <button key={format} disabled={busy}
              onClick={() => void window.cardhelper.report(result.id, format).catch(cause => {
                setFailed(true);
                setMessage(`报告导出失败：${cause instanceof Error ? cause.message : cause}`);
              })}>导出 {format.toUpperCase()}</button>)}
          </div>}
          <div className="table">
            <table><thead><tr><th>来源</th><th>目标路径</th><th>大小</th><th>复制策略</th><th>校验策略</th><th>结果</th></tr></thead>
              <tbody>{result.rows.slice(0, 200).map(row => {
                const outcome = outcomes.get(row.destination);
                const current = running ? progress.get(row.target) : undefined;
                const activePhase = current?.destination === row.destination ? phases[current.phase] : undefined;
                return <tr key={row.destination}>
                <td title={row.source}>{row.source}</td><td title={row.destination}>{row.destination}</td>
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
                <td title={outcome?.error ?? Object.entries(outcome?.checksums ?? {}).map(([name, digest]) => `${name}: ${digest}`).join('\n')}>{outcome ? outcomeLabels[outcome.status] : activePhase ?? (row.existing ? '已有文件，待检查' : '待复制')}</td>
              </tr>; })}</tbody>
            </table>
          </div>
          {result.rows.length > 200 && <p>显示前 200 条输出。</p>}
          {result.excluded.length > 0 && <details><summary>查看排除项</summary>
            <ul>{result.excluded.slice(0, 200).map(path => <li key={path}>{path}</li>)}</ul>
            {result.excluded.length > 200 && <p>显示前 200 项。</p>}
          </details>}
          </>}
        </section>
      </div>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
