const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const { readFile, writeFile, stat, lstat, realpath, readdir } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { isAbsolute, join } = require('node:path');
const { preview } = require('./preview.cjs');
const { startTransfer } = require('./transfer.cjs');
const { createJournal, latestJournal, identifyEndpoints } = require('./journal.cjs');
const { listLibraryWorkflows, readLibraryWorkflow, saveLibraryWorkflow, removeLibraryWorkflow } = require('./workflow-library.cjs');

const root = join(__dirname, '..');
const engineName = process.platform === 'win32' ? 'cardhelper-engine.exe' : 'cardhelper-engine';
const releaseEngine = join(root, 'engine', 'target', 'release', engineName);
const engine = existsSync(releaseEngine) ? releaseEngine : join(root, 'engine', 'target', 'debug', engineName);
const previews = new WeakMap();
const reports = new WeakMap();
function items(store, sender) {
  if (!store.has(sender)) store.set(sender, new Map());
  return store.get(sender);
}
const recovery = new WeakMap();
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
    defaultPath: 'cardhelper.workflow.json',
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

ipcMain.handle('workflow:preview', async ({ sender }, workflow) => {
  const before = await identifyEndpoints(workflow);
  const plan = await preview(engine, [], workflow);
  const endpoints = await identifyEndpoints(workflow);
  if (JSON.stringify(before) !== JSON.stringify(endpoints)) throw new Error('预览期间目录身份发生变化，请重新预览。');
  if (!plan.rows.length) throw new Error('没有可加入队列的输出文件。');
  const id = randomUUID();
  items(previews, sender).set(id, { workflow, fingerprint: plan.fingerprint, sourceFingerprint: plan.source_fingerprint,
    endpoints, previous: recovery.get(sender) });
  return { ...plan, id };
});

ipcMain.handle('workflow:remove-task', ({ sender }, id) => {
  items(previews, sender).delete(id);
  items(reports, sender).delete(id);
});

ipcMain.handle('workflow:recover', async ({ sender }) => {
  const job = await latestJournal(journalDirectory());
  if (!job) return null;
  recovery.set(sender, job);
  return { workflow: job.request.workflow, status: job.status, date: job.date, count: job.outcomes.length };
});
ipcMain.handle('workflow:clear-recovery', ({ sender }) => { recovery.delete(sender); });

ipcMain.handle('workflow:execute', async ({ sender }, id, verifyOnly = false) => {
  verifyOnly = verifyOnly === true;
  if (active || starting) throw new Error('已有复制任务正在启动或运行。');
  const pending = items(previews, sender);
  const request = pending.get(id);
  if (!request) throw new Error('找不到队列任务，请重新加入。');
  const previous = request.previous;
  const changed = previous && JSON.stringify(previous.endpoints) !== JSON.stringify(request.endpoints);
  const sourceChanged = previous && previous.request.sourceFingerprint !== request.sourceFingerprint;
  const unknown = request.endpoints.some(endpoint => !endpoint.identity);
  const warning = changed || sourceChanged || unknown;
  const answer = await dialog.showMessageBox(BrowserWindow.fromWebContents(sender), {
    type: warning ? 'warning' : 'question',
    message: warning ? '请确认当前来源和目标目录' : verifyOnly ? '按当前预览开始复验？' : '按当前预览开始复制？',
    detail: (changed || unknown ? '目录身份不同或无法可靠确认。请确认当前设备，旧任务结果不会沿用。\n' : '')
      + (sourceChanged ? '来源清单与上次任务不同，本次将按新预览执行。\n' : '')
      + (verifyOnly ? '复验按相对路径计划比较文件，不写入目标。未连接算法时使用 SHA-256。'
        : '已有文件只有重新校验且内容一致时才会复用。发生冲突时会保留原文件。'),
    buttons: [verifyOnly ? '开始复验' : '开始复制', '返回'],
    defaultId: 1,
    cancelId: 1,
  });
  if (answer.response !== 0) return null;
  if (active || starting || pending.get(id) !== request) throw new Error('任务状态已变化，请重新加入队列。');
  starting = true;
  pending.delete(id);
  let journal;
  let journalError;
  try {
    const current = await identifyEndpoints(request.workflow);
    if (JSON.stringify(current) !== JSON.stringify(request.endpoints)) throw new Error('来源或目标身份已变化，请重新预览。');
    const { workflow, fingerprint, sourceFingerprint } = request;
    if (!verifyOnly) journal = await createJournal(journalDirectory(), { workflow, fingerprint, sourceFingerprint }, current);
    if (sender.isDestroyed()) throw new Error('任务窗口已关闭。');
    const transfer = startTransfer(engine, { workflow, fingerprint }, outcome => {
      if (outcome.kind !== 'progress') void journal?.append({ type: 'file', outcome }).catch(error => {
        journalError ??= error;
        transfer.cancel();
      });
      if (!sender.isDestroyed()) sender.send('workflow:progress', id, outcome);
    }, verifyOnly);
    active = transfer;
    starting = false;
    const result = await transfer.result;
    items(reports, sender).set(id, { date: new Date().toISOString(), operation: verifyOnly ? 'verify' : 'copy', ...result });
    if (journalError) throw journalError;
    const status = result.outcomes.some(row => row.status === 'failed' || row.status === 'cancelled') ? 'incomplete' : 'finished';
    await journal?.append({ type: 'finished', status });
    return result;
  } finally {
    try { await journal?.close(); }
    finally { active = undefined; starting = false; }
  }
});

ipcMain.handle('workflow:cancel', () => active?.cancel());
ipcMain.handle('workflow:report', async ({ sender }, id, format) => {
  const report = items(reports, sender).get(id);
  if (!report || !['html', 'json'].includes(format)) throw new Error('没有可导出的报告。');
  const { filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(sender), {
    defaultPath: `cardhelper-report.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (!filePath) return false;
  const labels = { verified: '校验通过', reused: '校验后复用', copied: '复制完成，未校验', failed: '失败', cancelled: '已中止' };
  const body = format === 'json' ? JSON.stringify(report, null, 2) :
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>CardHelper 复制报告</title>'
    + (report.operation === 'verify' ? '<h1>所选素材复验报告</h1>' : '<h1>所选素材复制报告</h1>') + '<p>' + escapeHtml(report.date) + '</p>'
    + '<table border="1"><thead><tr><th>来源</th><th>目标</th><th>状态</th><th>校验值</th><th>备注</th></tr></thead><tbody>'
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
