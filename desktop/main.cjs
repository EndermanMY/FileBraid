const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const { readFile, writeFile, stat, lstat, realpath, readdir } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { isAbsolute, join } = require('node:path');
const { preview } = require('./preview.cjs');
const { startTransfer } = require('./transfer.cjs');
const { listShootingMedia, resolveMediaWorkflow } = require('./shooting-media.cjs');
const { createJournal, latestJournal, identifyEndpoints } = require('./journal.cjs');
const { listLibraryWorkflows, readLibraryWorkflow, saveLibraryWorkflow, removeLibraryWorkflow } = require('./workflow-library.cjs');

app.setPath('userData', join(app.getPath('appData'), 'cardhelper'));
const root = join(__dirname, '..');
const engineName = process.platform === 'win32' ? 'filebraid-engine.exe' : 'filebraid-engine';
const releaseEngine = join(root, 'engine', 'target', 'release', engineName);
const engine = existsSync(releaseEngine) ? releaseEngine : join(root, 'engine', 'target', 'debug', engineName);
const previews = new WeakMap();
const reports = new WeakMap();
function items(store, sender) {
  if (!store.has(sender)) store.set(sender, new Map());
  return store.get(sender);
}

const journalDirectory = () => join(app.getPath('userData'), 'jobs');
const workflowLibraryDirectory = () => join(app.getPath('userData'), 'presets');
let active;
let starting = false;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function openWindow() {
  const window = new BrowserWindow({
    width: 1350,
    height: 880,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#182532',
    ...(process.platform === 'win32' && {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#182532', symbolColor: '#e9edf0', height: 46 },
    }),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(join(root, 'dist', 'index.html'));
}

ipcMain.handle('workflow:shooting-media', () => listShootingMedia());

ipcMain.handle('workflow:sony-structure', async (_, { kind, value, output }) => {
  if (!['source', 'media'].includes(kind) || typeof value !== 'string' || typeof output !== 'string') {
    throw new Error('Sony 来源参数无效。');
  }
  const source = { id: 'sony-source', kind, value };
  const { workflow } = await resolveMediaWorkflow({ nodes: [source] }, () => listShootingMedia());
  return preview(engine, ['sony-structure'], { folder: workflow.nodes[0].value, output });
});

ipcMain.handle('workflow:directory', async () => {
  const { filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return filePaths[0] ?? null;
});

ipcMain.handle('workflow:directory-items', async (_, folder, relative) => {
  if (typeof folder !== 'string' || !isAbsolute(folder) || typeof relative !== 'string') {
    throw new Error('请选择来源目录。');
  }
  let current = await realpath(folder);
  for (const part of relative ? relative.split('/') : []) {
    if (!part || /[<>:"\\|?*\x00-\x1f]|[. ]$/.test(part)) throw new Error('目录路径无效。');
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('无法展开链接或非目录项目。');
  }
  return (await readdir(current, { withFileTypes: true }))
    .filter(entry => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
    .map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN'));
});

ipcMain.handle('workflow:open', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: '工作流', extensions: ['json'] }],
  });
  const path = filePaths[0];
  if (!path) return null;
  if ((await stat(path)).size > 1_000_000) throw new Error('工作流文件超过 1 MB。');
  return JSON.parse(await readFile(path, 'utf8'));
});

ipcMain.handle('workflow:save', async (_, workflow) => {
  const { filePath } = await dialog.showSaveDialog({
    defaultPath: 'filebraid.workflow.json',
    filters: [{ name: '工作流', extensions: ['json'] }],
  });
  if (!filePath) return false;
  await writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');
  return true;
});

ipcMain.handle('workflow-library:list', () => listLibraryWorkflows(workflowLibraryDirectory()));
ipcMain.handle('workflow-library:open', async (_, id) => (await readLibraryWorkflow(workflowLibraryDirectory(), id)).workflow);
ipcMain.handle('workflow-library:save', (_, name, workflow) => saveLibraryWorkflow(workflowLibraryDirectory(), name, workflow));
ipcMain.handle('workflow-library:remove', (_, id) => removeLibraryWorkflow(workflowLibraryDirectory(), id));

async function inspectWorkflow(workflow, useRecentSelection = false) {
  const resolved = await resolveMediaWorkflow(workflow, () => listShootingMedia(!useRecentSelection, useRecentSelection));
  return { ...resolved, endpoints: await inspectEndpoints(resolved) };
}

async function inspectEndpoints(resolved) {
  const endpoints = await identifyEndpoints(resolved.workflow);
  for (const endpoint of endpoints) {
    const device = resolved.media.find(device => device.node === endpoint.id);
    if (device) endpoint.media = device.id;
  }
  return endpoints;
}

ipcMain.handle('workflow:preview', async ({ sender }, workflow) => {
  const before = await inspectWorkflow(workflow, true);
  const [plan, checked] = await Promise.all([
    preview(engine, [], before.workflow),
    resolveMediaWorkflow(workflow, () => listShootingMedia(true)),
  ]);
  const endpoints = await inspectEndpoints(checked);
  const { media } = checked;
  if (JSON.stringify(before.endpoints) !== JSON.stringify(endpoints)) throw new Error('预览期间目录身份发生变化，请重新预览。');
  if (!plan.rows.length) throw new Error('没有可加入队列的输出文件。');
  const id = randomUUID();
  items(previews, sender).set(id, { workflow, fingerprint: plan.fingerprint, sourceFingerprint: plan.source_fingerprint,
    endpoints });
  return { ...plan, id, media };
});

ipcMain.handle('workflow:remove-task', ({ sender }, id) => {
  items(previews, sender).delete(id);
  items(reports, sender).delete(id);
});

ipcMain.handle('workflow:recover', async () => {
  const job = await latestJournal(journalDirectory());
  if (!job) return null;
  return { workflow: job.request.workflow, status: job.status, date: job.date, count: job.outcomes.length };
});

ipcMain.handle('workflow:execute', async ({ sender }, id, verifyOnly = false) => {
  verifyOnly = verifyOnly === true;
  if (active || starting) throw new Error('已有复制任务正在启动或运行。');
  const pending = items(previews, sender);
  const request = pending.get(id);
  if (!request) throw new Error('找不到队列任务，请重新加入。');
  starting = true;
  pending.delete(id);
  let journal;
  let journalError;
  try {
    const current = await inspectWorkflow(request.workflow);
    if (JSON.stringify(current.endpoints) !== JSON.stringify(request.endpoints)) throw new Error('来源或目标身份已变化，请重新预览。');
    const { workflow, fingerprint, sourceFingerprint } = request;
    if (!verifyOnly) journal = await createJournal(journalDirectory(),
      { workflow, fingerprint, sourceFingerprint, media: current.media }, current.endpoints);
    if (sender.isDestroyed()) throw new Error('任务窗口已关闭。');
    const transfer = startTransfer(engine, { workflow: current.workflow, fingerprint }, outcome => {
      if (outcome.kind !== 'progress') void journal?.append({ type: 'file', outcome }).catch(error => {
        journalError ??= error;
        transfer.cancel();
      });
      if (!sender.isDestroyed()) sender.send('workflow:progress', id, outcome);
    }, verifyOnly);
    active = { ...transfer, id, sender };
    starting = false;
    const result = await transfer.result;
    items(reports, sender).set(id, { date: new Date().toISOString(), operation: verifyOnly ? 'verify' : 'copy', media: current.media, ...result });
    if (journalError) throw journalError;
    const status = result.outcomes.some(row => row.status === 'failed' || row.status === 'cancelled') ? 'incomplete' : 'finished';
    await journal?.append({ type: 'finished', status });
    return result;
  } finally {
    try { await journal?.close(); }
    finally { active = undefined; starting = false; }
  }
});

ipcMain.handle('workflow:cancel', ({ sender }) => active?.sender === sender && active.cancel());
ipcMain.handle('workflow:control', ({ sender }, id, action) => {
  if (active?.sender !== sender || active.id !== id) return false;
  if (action === 'pause') return active.pause();
  if (action === 'resume') return active.resume();
  if (action === 'cancel') return active.cancel();
  return false;
});
ipcMain.handle('workflow:report', async ({ sender }, id, format) => {
  const report = items(reports, sender).get(id);
  if (!report || !['html', 'json'].includes(format)) throw new Error('没有可导出的报告。');
  const { filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(sender), {
    defaultPath: `filebraid-report.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (!filePath) return false;
  const labels = { verified: '校验通过', reused: '已跳过', copied: '复制完成，未校验', failed: '失败', cancelled: '已中止' };
  const mediaTypes = { sd: 'SD 卡', cfa: 'CFexpress Type A', 'shooting-storage': '拍摄存储' };
  const mediaRows = report.media.map(device => '<tr>' + [device.root, mediaTypes[device.type], device.mediaModel,
    device.mediaSerial, device.deviceModel, device.deviceSerial]
    .map(value => '<td>' + escapeHtml(value || '未读取') + '</td>').join('') + '</tr>').join('');
  const mediaTable = mediaRows ? '<h2>来源拍摄介质</h2><table border="1"><thead><tr><th>盘符</th><th>类型</th>'
    + '<th>介质型号</th><th>介质序列号</th><th>系统设备型号</th><th>系统设备序列号</th></tr></thead><tbody>'
    + mediaRows + '</tbody></table>' : '';
  const body = format === 'json' ? JSON.stringify(report, null, 2) :
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>FileBraid 复制报告</title>'
    + (report.operation === 'verify' ? '<h1>所选素材复验报告</h1>' : '<h1>所选素材复制报告</h1>') + '<p>' + escapeHtml(report.date) + '</p>'
    + mediaTable + '<table border="1"><thead><tr><th>来源</th><th>目标</th><th>状态</th><th>校验值</th><th>备注</th></tr></thead><tbody>'
    + report.outcomes.map(row => '<tr>' + [row.source, row.destination, labels[row.status],
      Object.entries(row.checksums ?? {}).map(([algorithm, digest]) => algorithm + ' ' + digest).join(' / '),
      [row.retried ? '已完整重拷' : '', row.error].filter(Boolean).join(' ')]
      .map(value => '<td>' + escapeHtml(value) + '</td>').join('') + '</tr>').join('')
    + '</tbody></table><h2>至少一条路径排除的来源</h2><ul>'
    + report.excluded.map(path => '<li>' + escapeHtml(path) + '</li>').join('') + '</ul></html>';
  await writeFile(filePath, body, 'utf8');
  return true;
});
app.on('before-quit', event => {
  if (active) {
    event.preventDefault();
    active.cancel();
    active.result.then(() => app.quit(), () => app.quit());
  }
});

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
  if (process.platform === 'win32') Menu.setApplicationMenu(null);
  openWindow();
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
