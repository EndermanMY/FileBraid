const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');

const root = process.env.FILEBRAID_QUEUE_TEST_ROOT;
const source = join(root, 'source');
const target = join(root, 'target');
const legacy = join(root, 'legacy.json');
const saved = join(root, 'saved.json');
let workflowToLoad = legacy;
const first = join(root, 'backup-1');
const second = join(root, 'backup-2');
mkdirSync(source);
mkdirSync(target);
mkdirSync(first);
mkdirSync(second);
writeFileSync(join(source, '原始文件.txt'), 'abc');
writeFileSync(legacy, JSON.stringify({
  version: 3,
  nodes: [
    { id: 's', kind: 'source', value: source, x: 0, y: 0 },
    { id: 'tree', kind: 'tree', value: '', x: 285, y: 0 },
    { id: 'd', kind: 'directory', value: '旧项目/原片', x: 150, y: 0 },
    { id: 'c', kind: 'standardcopy', value: '', x: 0, y: 150 },
    { id: 'v', kind: 'sha256', value: '', x: 0, y: 300 },
    { id: 't', kind: 'target', value: target, x: 300, y: 0 },
  ],
  edges: [
    { id: 'source-directory', source: 's', target: 'tree' },
    { id: 'files', source: 'tree', sourceHandle: 'out', target: 'd' },
    { id: 'archive', source: 'd', target: 't' },
    { id: 'transfer', source: 'c', target: 't' },
    { id: 'verify', source: 'v', target: 't' },
  ],
}));

const done = (message, code) => {
  writeFileSync(process.env.FILEBRAID_COPY_SMOKE_RESULT, message);
  app.exit(code);
};
const folders = [source, first, second];
dialog.showOpenDialog = async (_window, options) => {
  const request = options ?? _window;
  return { canceled: false, filePaths: [request.properties.includes('openDirectory') ? folders.shift() : workflowToLoad] };
};
dialog.showMessageBox = async () => { throw new Error('Queue tasks must start without a confirmation dialog'); };
let reportFile;
dialog.showSaveDialog = async (_window, options) => ({
  canceled: false,
  filePath: (options ?? _window).defaultPath.startsWith('filebraid-report.') ? reportFile : saved,
});
let simulatedMedia = [];
require('./shooting-media.cjs').listShootingMedia = async () => simulatedMedia;
app.once('web-contents-created', (_, contents) => {
  const inspect = (expression) => contents.executeJavaScript(expression);
  const wait = async (expression) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await inspect(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error('Expected UI: ' + expression + '\n' + await inspect('document.body.innerText'));
  };
  const click = async (name) => {
    const control = 'Array.from(document.querySelectorAll("button")).find(b => (b.innerText.trim() === ' + JSON.stringify(name) + ' || b.getAttribute("aria-label") === ' + JSON.stringify(name) + ') && !b.disabled)';
    await wait('Boolean(' + control + ')');
    await inspect(control + '.click()');
  };
  contents.once('did-finish-load', async () => {
    try {
      await wait('document.querySelectorAll(".kind-copy").length === 2');
      assert.equal(await inspect('document.querySelectorAll(".kind-directory").length'), 0);
      await wait('document.querySelectorAll(".kind-outputtree .target-tree-row").length === 3');
      await click('工作流库');
      await click('Sony 双目标工作流');
      await wait('document.querySelector(".kind-camera [role=status]")?.textContent === "请在上游选择介质或目录"');
      const cameraPorts = await inspect(`Array.from(document.querySelectorAll('.kind-camera .node-port'), row =>
        [row.textContent.trim(), row.querySelector('.react-flow__handle').classList.contains('react-flow__handle-right')])`);
      assert.deepEqual(cameraPorts, [
        ['文件', false], ['全部文件', true], ['照片文件', true], ['视频文件', true], ['代理文件', true],
        ['卡管理文件', true], ['LUT 文件', true], ['其他文件', true],
      ]);
      await click('双目标工作流');
      await wait('!document.querySelector(".kind-camera")');
      await click('节点库');
      const libraryNames = await inspect(`Array.from(document.querySelectorAll('.node-library button[draggable="true"]'), button => button.textContent)`);
      assert.deepEqual(libraryNames, [
        '源目录', '拍摄介质', '来源目录树', '目标目录树', '目标目录', 'Sony 素材分类', '按扩展名筛选', '合并文件', '排除文件',
        '复制', '标准复制策略', '流复制策略', 'CRC32 校验', 'BLAKE3 校验', 'MD5 校验', 'SHA-1 校验', 'SHA-256 校验', 'xxHash3-64 校验',
      ]);
      const titles = await inspect(`Array.from(document.querySelectorAll('.react-flow__node .node-title'), heading => heading.textContent)`);
      assert.ok(titles.includes('目标目录树') && titles.includes('源目录') && titles.includes('复制') && titles.includes('SHA-256 校验'));
      await wait('Boolean(document.querySelector(".react-flow__minimap"))');
      assert.ok(await inspect('document.querySelector(".react-flow__attribution").getBoundingClientRect().bottom < document.querySelector(".canvas-toolbar").getBoundingClientRect().top'));
      await click('小地图');
      await wait('!document.querySelector(".react-flow__minimap")');
      await click('小地图');
      await click('小地图设置');
      assert.ok(await inspect('document.querySelector(".canvas-map-settings") !== null'));
      await click('小地图设置');
      assert.ok(await inspect('(() => {         const canvas = document.querySelector(".canvas");         const panel = document.querySelector(".canvas-map-panel");         return canvas.contains(panel) && canvas.getBoundingClientRect().bottom > panel.getBoundingClientRect().bottom;       })()'));
      await click('小地图设置');
      await inspect('Array.from(document.querySelectorAll(".canvas-map-settings label")).find(label => label.textContent.includes("显示连接")).querySelector("input").click()');
      await wait('document.querySelectorAll(".canvas-map-svg .canvas-map-edge").length === 0');
      await inspect('Array.from(document.querySelectorAll(".canvas-map-settings label")).find(label => label.textContent.includes("显示连接")).querySelector("input").click()');
      await wait('document.querySelectorAll(".canvas-map-svg .canvas-map-edge").length > 0');
      assert.ok(await inspect('document.querySelector(".canvas-map-edge").getAttribute("d").includes("C")'));
      await click('选择或拖拽');
      await inspect('document.querySelector(".canvas-tool-popup button").click()');
      await wait('document.querySelector(".canvas-status")?.textContent.includes("左键框选")');
      await inspect(`document.querySelector('.canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }))`);
      await wait('document.querySelector(".canvas-status")?.textContent.includes("左键平移")');
      await click('缩放比例');
      await click('25%');
      await wait('Boolean(document.querySelector(".compact-canvas"))');
      await click('适配视图');
      await wait('!document.querySelector(".compact-canvas")');
      await new Promise(resolve => setTimeout(resolve, 210));
      const openContext = selector => inspect(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 430, clientY: 220 }))`);
      await openContext('[data-id="standardcopy"] [data-handleid="out"]');
      await wait('document.querySelectorAll(".pin-connections button").length === 2');
      await click('选中连线 2 · 复制');
      assert.ok(await inspect('Boolean(document.querySelector(\'[data-id="standardcopy:copy-b"] .react-flow__edgeupdater-source\'))'));
      assert.ok(await inspect('!document.querySelector(\'[data-id="standardcopy:copy-a"] .react-flow__edgeupdater-source\')'));
      const drag = async (selector, dx, dy, xRatio = 0.5) => {
        const point = await inspect(`(() => {
          const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return { x: Math.round(box.x + box.width * ${xRatio}), y: Math.round(box.y + box.height / 2) };
        })()`);
        await dragPoint(point, dx, dy);
      };
      const dragPoint = async (point, dx, dy) => {
        contents.sendInputEvent({ type: 'mouseMove', ...point });
        contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
        for (const fraction of [0.25, 0.5, 0.75, 1]) {
          await new Promise(resolve => setTimeout(resolve, 20));
          contents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x + dx * fraction),
            y: Math.round(point.y + dy * fraction), modifiers: ['leftButtonDown'] });
        }
        contents.sendInputEvent({ type: 'mouseUp', x: point.x + dx, y: point.y + dy, button: 'left', clickCount: 1 });
        await new Promise(resolve => setTimeout(resolve, 60));
      };
      const sourceBox = '[data-id="source"].react-flow__node';
      const originalY = await inspect(`document.querySelector(${JSON.stringify(sourceBox)}).getBoundingClientRect().top`);
      await drag(sourceBox + ' .path', 0, -25);
      assert.ok(await inspect(`document.querySelector(${JSON.stringify(sourceBox)}).getBoundingClientRect().top < ${originalY - 10}`));
      await wait(`Boolean(document.querySelector(${JSON.stringify(sourceBox + ' .path-resize')}))`);
      const originalHeight = await inspect(`document.querySelector(${JSON.stringify(sourceBox)}).getBoundingClientRect().height`);
      const originalWidth = await inspect(`document.querySelector(${JSON.stringify(sourceBox)}).getBoundingClientRect().width`);
      await drag(sourceBox + ' .path-resize', 40, 40);
      assert.ok(await inspect(`document.querySelector(${JSON.stringify(sourceBox)}).getBoundingClientRect().height > ${originalHeight + 10}`));
      assert.ok(await inspect(`document.querySelector(${JSON.stringify(sourceBox)}).getBoundingClientRect().width > ${originalWidth + 10}`));
      const rootInput = await inspect(`(() => {
        const node = document.querySelector('.kind-outputtree');
        const port = node.querySelector('.node-body .output-root-port');
        return {
          label: port?.textContent,
          handle: port?.querySelector('.react-flow__handle-left')?.getAttribute('data-handleid'),
          inTopPorts: Boolean(node.querySelector('.node-ports [data-handleid="files"]')),
        };
      })()`);
      assert.match(rootInput.label, /文件\s*写入目标根目录/);
      assert.equal(rootInput.handle, 'files');
      assert.equal(rootInput.inTopPorts, false);
      const ports = await inspect('Array.from(document.querySelector(".kind-copy").querySelectorAll(".node-port"), node => node.textContent.trim())');
      assert.deepEqual(ports, ['输入文件', '复制策略', '校验策略', '输出文件']);
      const targetPorts = await inspect('Array.from(document.querySelector(".kind-target").querySelectorAll(".node-port"), node => node.textContent.trim())');
      assert.deepEqual(targetPorts, ['文件']);
      await click('加入队列');
      await wait('document.querySelector("[role=alert]")?.textContent.includes("请选择来源目录")');
      for (const id of ['source', 'a', 'b']) {
        if (id === 'a') {
          await click('加入队列');
          await wait('document.querySelector("[role=alert]")?.textContent.includes("请选择目标目录")');
        }
        const control = 'document.querySelector(' + JSON.stringify('.react-flow__node[data-id="' + id + '"] button') + ')';
        await wait('Boolean(' + control + ' && !' + control + '.disabled)');
        await inspect(control + '.click()');
        await wait('Boolean(' + control + ' && !' + control + '.disabled)');
      }
      await click('加入队列');
      await wait('document.body.innerText.includes("2 条输出")');
      const queueCursor = 'getComputedStyle(document.querySelector(".queue-list-actions button")).cursor';
      assert.equal(await inspect(queueCursor), 'pointer');
      assert.deepEqual(await inspect(`Array.from(document.querySelectorAll('.table tbody tr:first-child td[title]'), cell => cell.title).slice(0, 2)`), [
        join(source, '原始文件.txt'), join(first, '项目', 'A机', '卡001', '原始文件.txt'),
      ]);
      await click('开始复制');
      await wait('document.querySelector(".queue-item")?.innerText.includes("已完成")');
      assert.equal(await inspect(queueCursor), 'not-allowed');
      for (const directory of [first, second]) {
        assert.equal(readFileSync(join(directory, '项目', 'A机', '卡001', '原始文件.txt'), 'utf8'), 'abc');
      }
      await click('工作流');
      await click('工作流库');
      await click('打开工作流文件');
      await wait('document.querySelectorAll(".kind-copy").length === 1 && document.querySelectorAll(".react-flow__edge").length === 6');
      await wait('document.querySelectorAll(".kind-outputtree .target-tree-row").length === 2');
      const sourceOutput = await inspect(`(() => {
        const node = document.querySelector('.kind-tree');
        const row = node.querySelector('.node-body .source-root-port');
        const handle = row?.querySelector('.react-flow__handle-right');
        return {
          id: handle?.getAttribute('data-handleid'),
          label: row?.textContent,
          belowPath: row?.getBoundingClientRect().top >= node.querySelector('.path').getBoundingClientRect().bottom,
          aboveTree: row?.getBoundingClientRect().bottom <= node.querySelector('.source-tree').getBoundingClientRect().top,
        };
      })()`);
      assert.equal(sourceOutput.id, 'out');
      assert.match(sourceOutput.label, /输出全部文件/);
      assert.ok(sourceOutput.belowPath && sourceOutput.aboveTree);
      await click('小地图');
      await click('适配视图');
      await new Promise(resolve => setTimeout(resolve, 230));
      await click('展开文件夹树');
      const treeScroll = 'document.querySelector(".kind-tree .source-tree-scroll")';
      await wait('Boolean(' + treeScroll + '?.querySelector(".source-tree-row"))');
      const scrollHeight = await inspect(treeScroll + '.clientHeight');
      await openContext('.kind-tree .node-title');
      await inspect(`document.querySelector('.graph-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await drag('.kind-tree .path-resize', 0, 50);
      const resizedTree = await inspect(`(() => {
        const tree = document.querySelector('.kind-tree');
        const handle = tree.querySelector('.path-resize').getBoundingClientRect();
        return { height: tree.style.height, scroll: tree.querySelector('.source-tree-scroll').clientHeight,
          x: handle.x, y: handle.y, hit: document.elementFromPoint(handle.x + handle.width / 2, handle.y + handle.height / 2)?.className };
      })()`);
      assert.ok(resizedTree.scroll > scrollHeight + 10, JSON.stringify({ scrollHeight, ...resizedTree }));
      await inspect('document.querySelector(\'button[aria-label="在 旧项目 中添加子文件夹"]\').click()');
      await wait('document.querySelectorAll(".kind-outputtree .target-tree-row").length === 3');
      await inspect('document.querySelector(\'button[aria-label="在 旧项目 同级添加文件夹"]\').click()');
      await wait('document.querySelectorAll(".kind-outputtree .target-tree-row").length === 4');
      const moveUp = 'document.querySelector(\'button[aria-label="上移 原片"]\')';
      const moveDown = 'document.querySelector(\'button[aria-label="下移 原片"]\')';
      assert.equal(await inspect(moveUp + '?.disabled'), true);
      assert.equal(await inspect(moveDown + '?.disabled'), false);
      await inspect(moveDown + '.click()');
      await wait(moveDown + '?.disabled === true');
      await inspect(moveUp + '.click()');
      await wait(moveUp + '?.disabled === true');
      await inspect(moveDown + '.click()');
      await wait(moveDown + '?.disabled === true');
      const topProject = 'document.querySelector(\'button[aria-label="上移 旧项目"]\')';
      const bottomProject = 'document.querySelector(\'button[aria-label="下移 旧项目"]\')';
      await inspect(bottomProject + '.click()');
      await wait(bottomProject + '?.disabled === true');
      await inspect(topProject + '.click()');
      await wait(topProject + '?.disabled === true');
      assert.equal(await inspect(`getComputedStyle(document.querySelector('.target-tree ul ul .target-tree-row'), '::after').borderTopWidth`), '1px');
      assert.equal(await inspect(`getComputedStyle(document.querySelector('.target-tree > ul > li > .target-tree-row'), '::after').content`), 'none');
      await click('保存工作流文件');
      await wait('document.body.innerText.includes("工作流已保存。")');
      const snapshot = JSON.parse(readFileSync(saved, 'utf8'));
      assert.ok(snapshot.nodes.find(node => node.id === 'tree')?.height > 225);
      const structure = JSON.parse(snapshot.nodes.find(node => node.id === 'd').value);
      const [project, child, media, sibling] = structure;
      assert.equal(project.name, '旧项目');
      assert.equal(media.name, '原片');
      assert.equal(media.parent, project.id);
      assert.equal(child.parent, project.id);
      assert.equal(sibling.parent, undefined);
      assert.equal(snapshot.edges.find(edge => edge.id === 'files').targetHandle, 'folder:' + media.id);
      await click('双目标工作流');
      await wait('document.querySelectorAll(".kind-copy").length === 2');
      snapshot.edges.push({ id: 'root-files', source: 'tree', sourceHandle: 'out', target: 'd', targetHandle: 'files' });
      writeFileSync(saved, JSON.stringify(snapshot));
      workflowToLoad = saved;
      await click('打开工作流文件');
      await wait('document.querySelectorAll(".kind-outputtree .target-tree-row").length === 4');
      assert.equal(await inspect(`document.querySelector('.kind-outputtree .node-title').textContent`), '目标目录树');
      const names = 'Array.from(document.querySelectorAll(".kind-outputtree input"), input => input.value)';
      const expectedNames = ['旧项目', '新文件夹', '原片', '新文件夹'];
      assert.deepEqual(await inspect(names), expectedNames);
      await inspect(`(() => {
        const input = document.querySelector('input[aria-label="工作流名称"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '目录结构测试');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await click('存到工作流库');
      await wait('document.body.innerText.includes("已存入本机工作流库")');
      await click('双目标工作流');
      await wait('document.querySelectorAll(".kind-copy").length === 2');
      await click('目录结构测试');
      await wait('document.querySelectorAll(".kind-outputtree .target-tree-row").length === 4');
      assert.deepEqual(await inspect(names), expectedNames);
      await click('加入队列');
      await wait('document.body.innerText.includes("原始文件.txt")');
      await click('开始复制');
      await wait('document.querySelector(\'.queue-item[aria-pressed="true"]\')?.innerText.includes("已完成")');
      assert.equal(readFileSync(join(target, '旧项目', '原片', '原始文件.txt'), 'utf8'), 'abc');
      assert.equal(readFileSync(join(target, '原始文件.txt'), 'utf8'), 'abc');
      await click('工作流');
      const afterCopySource = join(root, 'after-copy-source');
      const afterCopyTarget = join(root, 'after-copy-target');
      mkdirSync(afterCopySource);
      mkdirSync(afterCopyTarget);
      for (const name of ['1.bin', '2.bin']) writeFileSync(join(afterCopySource, name), Buffer.alloc(2 * 1024 * 1024, 3));
      const excludedPath = join(afterCopySource, '排除项.txt');
      writeFileSync(excludedPath, 'excluded');
      const staged = {
        version: 4,
        nodes: [
          { id: 's', kind: 'source', value: afterCopySource, x: 0, y: 0 },
          { id: 'filter', kind: 'filter', value: 'bin', x: 150, y: 0 },
          { id: 'strategy', kind: 'fastcopy', value: JSON.stringify({ limit_mib_s: 1, block_mib: 1 }), x: 0, y: 150 },
          { id: 'check', kind: 'sha256', value: 'after_copy', x: 0, y: 300 },
          { id: 'copy', kind: 'copy', value: '', x: 300, y: 0 },
          { id: 't', kind: 'target', value: afterCopyTarget, x: 600, y: 0 },
        ],
        edges: [
          { id: 'source', source: 's', target: 'filter', targetHandle: 'files' },
          { id: 'files', source: 'filter', target: 'copy', targetHandle: 'files' },
          { id: 'strategy', source: 'strategy', target: 'copy', targetHandle: 'transfer' },
          { id: 'check', source: 'check', target: 'copy', targetHandle: 'verify' },
          { id: 'operation', source: 'copy', target: 't', targetHandle: 'operation' },
        ],
      };
      const openFixture = async workflow => {
        workflowToLoad = join(root, 'queue-regression.json');
        writeFileSync(workflowToLoad, JSON.stringify(workflow));
        await click('打开工作流文件');
        await wait('!Array.from(document.querySelectorAll("button")).find(button => button.innerText.trim() === "打开工作流文件")?.disabled');
      };
      await openFixture({ ...staged, nodes: staged.nodes.map(node => node.id === 't'
        ? { ...node, value: join(root, 'removed-target') } : node) });
      await click('加入队列');
      await wait('document.querySelector("[role=alert]")?.textContent.includes("目标目录不存在")');
      await openFixture(staged);
      await click('加入队列');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("待执行")');
      await click('开始复制');
      await wait('document.querySelector(".table tbody tr:first-child .file-status [role=img]")?.getAttribute("aria-label") === "已写入，待校验"');
      assert.ok(await inspect('document.querySelector(".transfer-target .live-target-speed")?.textContent.includes("写入") && /[1-9]/.test(document.querySelector(".transfer-target .live-target-speed").textContent)'));
      assert.equal(await inspect('document.querySelector(".queue-detail details li")?.textContent'), excludedPath);
      const totalPosition = 'document.querySelector(".transfer-target progress").position';
      assert.ok(await inspect(totalPosition + ' >= 0.25 && ' + totalPosition + ' <= 0.5'));
      assert.ok(await inspect('Array.from(document.querySelectorAll(".table tbody tr:first-child .file-hash"), cell => cell.textContent).join(" ").match(/^[0-9A-F]{4}:[0-9A-F]{4} —$/) !== null'));
      const rowProgress = 'document.querySelector(\'.file-status [role="progressbar"][data-state="copy"]\')';
      await wait(`Number(${rowProgress}?.getAttribute('aria-valuenow')) > 0 && Number(${rowProgress}?.getAttribute('aria-valuenow')) < 100`);
      assert.equal(await inspect(`getComputedStyle(${rowProgress}).animationName`), 'none');
      await click('暂停');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("已暂停")');
      const pausedRowProgress = await inspect(`${rowProgress}?.getAttribute('aria-valuenow')`);
      assert.ok(pausedRowProgress > 0 && pausedRowProgress < 100);
      await new Promise(resolve => setTimeout(resolve, 2200));
      assert.equal(await inspect(`${rowProgress}?.getAttribute('aria-valuenow')`), pausedRowProgress);
      assert.ok(await inspect('document.querySelector(".table tbody tr:first-child .file-status [role=img]")?.getAttribute("aria-label") === "已写入，待校验"'));
      await click('继续');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("已完成")');
      assert.ok(await inspect('Array.from(document.querySelectorAll(".table tbody .file-status [role=img]")).every(icon => icon.getAttribute("aria-label") === "校验通过")'));
      assert.equal(await inspect(totalPosition), 1);
      assert.ok(await inspect('document.querySelectorAll(".file-hash[data-comparison=match]").length === 4 && Array.from(document.querySelectorAll(".file-status")).every(cell => !cell.textContent.trim())'));
      assert.ok(await inspect('document.querySelector(".speed-chart svg path[fill^=url]") !== null'));
      const shownCurves = 'Array.from(document.querySelectorAll(".speed-chart [data-speed]"), curve => curve.dataset.speed)';
      assert.deepEqual(await inspect(shownCurves), ['write', 'read']);
      assert.equal(await inspect('document.querySelectorAll(".speed-y span").length'), 5);
      assert.ok(await inspect(`Array.from(document.querySelectorAll('.speed-chart [data-speed] path[fill="none"]')).every(path =>
        (path.getAttribute('d').match(/M /g) ?? []).length === 1)`));
      await click('校验读取');
      assert.deepEqual(await inspect(shownCurves), ['write']);
      await click('复制写入');
      assert.deepEqual(await inspect(shownCurves), []);
      await click('校验读取');
      assert.deepEqual(await inspect(shownCurves), ['read']);
      await click('重置任务');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("待执行") && !document.querySelector(".speed-chart")');
      assert.equal(readFileSync(join(afterCopyTarget, '1.bin')).length, 2 * 1024 * 1024);
      assert.ok(await inspect('document.querySelector(".transfer-target").textContent.includes("0 项待新写入 · 2 项已有文件")'));
      await click('开始复制');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("已完成")');
      assert.ok(await inspect('Array.from(document.querySelectorAll(".table tbody .file-status [role=img]")).every(icon => icon.getAttribute("aria-label") === "已跳过")'));
      assert.equal(await inspect('document.querySelectorAll(".table .file-status [data-state=reused] svg rect").length'), 2);
      assert.ok(await inspect('Boolean(document.querySelector(\'.speed-chart [data-speed="read"]\')) && !document.querySelector(\'.speed-chart [data-speed="write"]\')'));
      await inspect('document.querySelector(".file-status-guide summary").click()');
      await wait('document.querySelector(".file-status-guide")?.open === true');
      assert.ok(await inspect('Array.from(document.querySelectorAll(".file-status-guide tr")).some(row => row.innerText.includes("已跳过") && row.innerText.includes("跳过写入"))'));
      await inspect('document.querySelector(".file-status-guide summary").click()');
      await click('重置任务');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("待执行")');
      await click('仅复验');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("已完成")');
      assert.ok(await inspect('Boolean(document.querySelector(\'.speed-chart [data-speed="read"]\'))'));
      assert.ok(await inspect('!document.querySelector(\'.speed-chart [data-speed="write"]\')'));
      await click('工作流');
      await openFixture({
        ...staged,
        nodes: staged.nodes.filter(node => node.id !== 'check').map(node => node.id === 'strategy'
          ? { ...node, kind: 'standardcopy', value: '' } : node.id === 't'
          ? { ...node, value: second } : node),
        edges: staged.edges.filter(edge => edge.id !== 'check'),
      });
      await click('加入队列');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("待执行")');
      await click('开始复制');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("已完成")');
      assert.ok(await inspect('Array.from(document.querySelectorAll(".table tbody .file-status [role=img]")).every(icon => icon.getAttribute("aria-label") === "复制完成，未校验")'));
      await click('工作流');
      const cancelledTarget = join(root, 'cancelled-target');
      mkdirSync(cancelledTarget);
      await openFixture({ ...staged, nodes: staged.nodes.map(node => node.id === 't'
        ? { ...node, value: cancelledTarget } : node) });
      await click('加入队列');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("待执行")');
      await click('开始复制');
      await wait('document.querySelector(".table tbody tr:first-child .file-status [role=img]")?.getAttribute("aria-label") === "已写入，待校验"');
      assert.ok(await inspect('document.querySelector(".transfer-target .live-target-speed")?.textContent.includes("写入") && /[1-9]/.test(document.querySelector(".transfer-target .live-target-speed").textContent)'));
      await click('暂停');
      await click('取消任务');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("已停止")');
      assert.deepEqual(readdirSync(cancelledTarget), []);
      assert.equal(await inspect('document.querySelector(".transfer-target progress").value'), 0);
      assert.ok(await inspect('document.querySelector(".transfer-target").textContent.includes("2 项已取消")'));
      await click('重置任务');
      await wait('document.querySelector(".queue-item[aria-pressed=true]")?.innerText.includes("待执行") && !document.querySelector(".speed-chart")');
      await click('工作流');
      await inspect(`document.querySelector('.canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))`);
      await openContext('.react-flow__pane');
      await inspect('document.querySelector(".graph-organize").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))');
      await wait('Boolean(document.querySelector(".graph-organize .graph-menu-subpanel"))');
      assert.ok(await inspect(`(() => {
        const root = document.querySelector('.graph-menu').getBoundingClientRect();
        const branch = document.querySelector('.organize-actions').getBoundingClientRect();
        return branch.left >= root.right - 8 || branch.right <= root.left + 8;
      })()`));
      const nodeBoxes = `Array.from(document.querySelectorAll('.react-flow__node'), node => {
        const { left, top, right, bottom } = node.getBoundingClientRect();
        return { id: node.dataset.id, left, top, right, bottom };
      })`;
      const beforeAlignment = await inspect(nodeBoxes);
      await click('左对齐');
      const afterAlignment = await inspect(nodeBoxes);
      assert.deepEqual(afterAlignment.map(node => [node.id, node.top]), beforeAlignment.map(node => [node.id, node.top]));
      for (const [index, node] of afterAlignment.entries()) {
        for (const other of afterAlignment.slice(index + 1)) {
          assert.ok(node.right <= other.left || other.right <= node.left || node.bottom <= other.top || other.bottom <= node.top);
        }
      }
      await openContext('[data-id="s"] .node-title');
      await click('将所选节点建组');
      await wait('document.querySelector(".workflow-group-name")?.textContent === "组 1"');
      await openContext('.workflow-group-name');
      await click('重命名组');
      await inspect(`(() => {
        const input = document.querySelector('.group-rename input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '素材整理');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await click('保存名称');
      await wait('document.querySelector(".workflow-group-name")?.textContent === "素材整理"');
      await wait('Boolean(document.querySelector(\'[data-id="s"] .path-resize\'))');
      await click('保存工作流文件');
      await wait('document.body.innerText.includes("工作流已保存。")');
      const grouped = JSON.parse(readFileSync(saved, 'utf8'));
      const groupLabel = '.workflow-group-name';
      assert.equal(await inspect('getComputedStyle(document.querySelector(".workflow-group")).pointerEvents'), 'none');
      const originalGroupLeft = await inspect('document.querySelector(".workflow-group").getBoundingClientRect().left');
      await drag(groupLabel, 25, 0, 0.16);
      assert.ok(await inspect(`document.querySelector(".workflow-group").getBoundingClientRect().left > ${originalGroupLeft + 10}`));
      assert.ok(grouped.nodes.every(node => node.group === '组 1' && node.groupName === '素材整理'));
      workflowToLoad = saved;
      await click('打开工作流文件');
      await wait('document.querySelector(".workflow-group-name")?.textContent === "素材整理"');
      workflowToLoad = join(root, 'reconnect.json');
      writeFileSync(workflowToLoad, JSON.stringify({
        version: 4,
        nodes: [
          { id: 'original', kind: 'source', value: source, x: 0, y: 0 },
          { id: 'alternate', kind: 'source', value: source, x: 0, y: 240 },
          { id: 'camera', kind: 'camera', value: '', x: 390, y: 0 },
          { id: 'merge', kind: 'merge', value: '', x: 390, y: 240 },
          { id: 'tree', kind: 'tree', value: source, x: 720, y: 0 },
        ],
        edges: [{ id: 'route', source: 'original', target: 'camera', sourceHandle: 'out', targetHandle: 'files' }],
      }));
      await click('打开工作流文件');
      await wait('Boolean(document.querySelector(\'[data-id="route"].react-flow__edge\'))');
      await click('适配视图');
      await new Promise(resolve => setTimeout(resolve, 230));
      const pin = (node, handle) => `[data-id="${node}"] [data-handleid="${handle}"]`;
      const pointAt = selector => inspect(`(() => {
        const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return {x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2)};
      })()`);
      const dragTo = async (selector, target) => {
        const start = await pointAt(selector);
        await dragPoint(start, target.x - start.x, target.y - start.y);
      };
      const saveRouteWorkflow = async () => {
        await click('保存工作流文件');
        await wait('document.querySelector(".workflow-message")?.textContent === "工作流已保存。"');
        return JSON.parse(readFileSync(saved, 'utf8'));
      };
      const readRoute = async () => (await saveRouteWorkflow()).edges.find(edge => edge.id === 'route');
      const grip = (edge, end) => `[data-id="${edge}"].react-flow__edge .react-flow__edgeupdater-${end}`;
      await dragTo(grip('route', 'source'), await pointAt(pin('alternate', 'out')));
      assert.equal((await readRoute()).source, 'alternate', 'Dragging a connected output changes the source');
      await dragTo(grip('route', 'target'), await pointAt(pin('tree', 'out')));
      assert.equal((await readRoute()).target, 'camera', 'Dropping on an incompatible port preserves the edge');
      await dragTo(grip('route', 'target'), await pointAt(pin('merge', 'files')));
      assert.equal((await readRoute()).target, 'merge', 'Dragging a connected input changes the destination');
      const blank = await inspect(`(() => {
        const pane = document.querySelector('.react-flow__pane');
        const b = pane.getBoundingClientRect();
        for (let y = b.bottom - 48; y > b.top + 48; y -= 24) {
          const x = Math.round(b.left + b.width / 2);
          if (document.elementFromPoint(x, Math.round(y)) === pane) return {x, y: Math.round(y)};
        }
      })()`);
      assert.ok(blank);
      await dragTo(pin('alternate', 'out'), await pointAt(pin('camera', 'files')));
      await wait('document.querySelectorAll(".react-flow__edge").length === 2');
      const routeSourceGrip = JSON.stringify(grip('route', 'source'));
      assert.ok(await inspect(`!document.querySelector(${routeSourceGrip})`), 'Shared endpoint waits for an edge selection');
      await openContext(pin('alternate', 'out'));
      await wait('document.querySelectorAll(".pin-connections button").length === 2');
      await click('选中连线 1 · 合并文件');
      await wait(`Boolean(document.querySelector(${routeSourceGrip}))`);
      await dragTo(grip('route', 'source'), blank);
      assert.equal(await readRoute(), undefined, 'Dropping the selected endpoint on empty canvas disconnects it');
      const remaining = JSON.parse(readFileSync(saved, 'utf8')).edges;
      assert.deepEqual(remaining.map(({ source, target }) => [source, target]), [['alternate', 'camera']]);
      for (let index = 0; index < 24; index++) writeFileSync(join(source, `tree-${index}.txt`), '');
      await click('展开文件夹树');
      await wait('Boolean(document.querySelector(".kind-tree .source-tree-row .react-flow__handle-right"))');
      assert.ok(await inspect(`(() => {
        const tree = document.querySelector('.kind-tree');
        const handle = tree.querySelector('.source-tree-row .react-flow__handle-right').getBoundingClientRect();
        const scroll = tree.querySelector('.source-tree-scroll');
        const hit = document.elementFromPoint(handle.x + handle.width / 2, handle.y + handle.height / 2);
        return Math.abs(tree.getBoundingClientRect().right - handle.x - handle.width / 2) < 2 &&
          hit?.matches('.react-flow__handle-right') && scroll.scrollHeight > scroll.clientHeight &&
          scroll.clientLeft > 0 && getComputedStyle(scroll.firstElementChild).direction === 'ltr';
      })()`), 'Source tree handles align to the right edge and the scrollbar is on the left');
      const treeFile = pin('tree', 'item:tree-0.txt');
      await dragTo(treeFile, await pointAt(pin('merge', 'files')));
      await wait('document.querySelectorAll(".react-flow__edge").length === 2');
      const treeRoute = (await saveRouteWorkflow()).edges.find(edge => edge.source === 'tree');
      assert.equal(treeRoute?.sourceHandle, 'item:tree-0.txt');
      await inspect('document.querySelector(".kind-tree .source-tree-scroll").scrollTop = 10000');
      await wait('Boolean(document.querySelector(".kind-tree .route-port [data-handleid=\'item:tree-0.txt\']"))');
      assert.equal(await inspect('document.querySelectorAll(".react-flow__edge").length'), 2);
      await dragTo(pin('camera', 'sony:videos'), await pointAt(pin('merge', 'files')));
      await wait('document.querySelectorAll(".react-flow__edge").length === 3');
      const sonyEdge = (await saveRouteWorkflow()).edges.find(edge =>
        edge.source === 'camera' && edge.sourceHandle === 'sony:videos' && edge.target === 'merge');
      assert.ok(sonyEdge);
      await click('双目标工作流');
      await wait('document.querySelectorAll(".react-flow__edge").length === 9');
      workflowToLoad = saved;
      await click('打开工作流文件');
      await wait(`Array.from(document.querySelectorAll('.react-flow__edge')).some(edge => edge.dataset.id === ${JSON.stringify(sonyEdge.id)})`);

      const matrixSource = join(root, 'matrix-source');
      const smallPath = join('notes', 'day-1', 'small.bin');
      const largePath = 'video.bin';
      const small = Buffer.alloc(4096, 0x31);
      const large = Buffer.alloc(4 * 1024 * 1024, 0x79);
      const sample = new Map([[smallPath, small], [largePath, large]]);
      const digest = bytes => createHash('sha256').update(bytes).digest('hex');
      const putFile = (folder, path, bytes) => {
        const file = join(folder, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      };
      for (const [path, bytes] of sample) putFile(matrixSource, path, bytes);
      const workflowFor = targets => {
        const nodes = [
          { id: 'matrix-source', kind: 'source', value: matrixSource, x: 0, y: 0 },
          { id: 'matrix-copy-strategy', kind: 'fastcopy', value: JSON.stringify({ block_mib: 1, limit_mib_s: 2 }), x: 0, y: 180 },
          { id: 'matrix-verify', kind: 'sha256', value: 'per_file', x: 0, y: 380 },
        ];
        const edges = [];
        for (const [index, value] of targets.entries()) {
          const copy = `matrix-copy-${index}`;
          const target = `matrix-target-${index}`;
          nodes.push({ id: copy, kind: 'copy', value: '', x: 350, y: index * 240 },
            { id: target, kind: 'target', value, x: 680, y: index * 240 });
          edges.push(
            { id: `${copy}-files`, source: 'matrix-source', target: copy, targetHandle: 'files' },
            { id: `${copy}-strategy`, source: 'matrix-copy-strategy', target: copy, targetHandle: 'transfer' },
            { id: `${copy}-verify`, source: 'matrix-verify', target: copy, targetHandle: 'verify' },
            { id: `${copy}-target`, source: copy, target, targetHandle: 'operation' },
          );
        }
        return { version: 4, nodes, edges };
      };
      const queueState = state => wait(`document.querySelector('.queue-item[aria-pressed=true]')?.innerText.includes(${JSON.stringify(state)})`);
      const queueFixture = async targets => {
        await click('工作流');
        await openFixture(workflowFor(targets));
        await click('加入队列');
        await queueState('待执行');
      };
      const preview = async (folder, newCount, existingCount) => {
        const detail = await inspect(`Array.from(document.querySelectorAll('.transfer-target'), card => ({
          path: card.querySelector('strong').title, summary: card.querySelector('span').textContent,
        }))`);
        assert.equal(detail.find(card => card.path === folder)?.summary, `预览：${newCount} 项待新写入 · ${existingCount} 项已有文件`);
        const paths = await inspect('Array.from(document.querySelectorAll(".table tbody tr td:nth-child(2)"), cell => cell.title)');
        assert.ok([...sample.keys()].every(path => paths.includes(join(folder, path))), JSON.stringify(paths));
      };
      const downloadReport = async (name, format) => {
        reportFile = join(root, `${name}.${format.toLowerCase()}`);
        await click(`导出 ${format}`);
        for (let attempt = 0; attempt < 80; attempt++) {
          if (existsSync(reportFile) && statSync(reportFile).size > 0) return readFileSync(reportFile, 'utf8');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error(`Report was not written: ${name}.${format}`);
      };
      const checkedOutputs = folder => {
        for (const [path, bytes] of sample) assert.equal(digest(readFileSync(join(folder, path))), digest(bytes));
      };
      const outcomeLabels = 'Array.from(document.querySelectorAll(".table tbody .file-status [role=img]"), icon => icon.getAttribute("aria-label")).sort()';
      const chart = kind => inspect(`Boolean(document.querySelector('.speed-chart [data-speed="${kind}"]'))`);
      for (const [name, existing] of [
        ['empty', []], ['partial', [smallPath]], ['full', [smallPath, largePath]],
      ]) {
        const destination = join(root, `matrix-${name}`);
        mkdirSync(destination);
        for (const path of existing) putFile(destination, path, sample.get(path));
        const timestamps = existing.map(path => statSync(join(destination, path)).mtimeMs);
        await queueFixture([destination]);
        await preview(destination, sample.size - existing.length, existing.length);
        await click('开始复制');
        await queueState('已完成');
        checkedOutputs(destination);
        assert.deepEqual(existing.map(path => statSync(join(destination, path)).mtimeMs), timestamps);
        assert.deepEqual(await inspect(outcomeLabels), [...sample.keys()].map(path => existing.includes(path) ? '已跳过' : '校验通过').sort());
        assert.equal(await chart('write'), existing.length < sample.size);
        assert.equal(await chart('read'), true);
        const report = JSON.parse(await downloadReport(name, 'JSON'));
        const html = await downloadReport(name, 'HTML');
        assert.equal(report.operation, 'copy');
        assert.equal(report.outcomes.length, sample.size);
        for (const [path, bytes] of sample) {
          const row = report.outcomes.find(row => row.destination.endsWith(join(destination, path)));
          assert.equal(row?.status, existing.includes(path) ? 'reused' : 'verified');
          assert.ok(Object.values(row.checksums).includes(digest(bytes)));
          assert.ok(html.includes(path.split('\\').at(-1)) && html.includes(digest(bytes)));
        }
        assert.equal((html.match(/<td>已跳过<\/td>/g) ?? []).length, existing.length);
      }

      const internalTarget = join(root, 'matrix-internal');
      const externalTarget = join(process.env.FILEBRAID_TEST_EXTERNAL_ROOT ?? root, 'matrix-external');
      mkdirSync(internalTarget);
      mkdirSync(externalTarget);
      await queueFixture([internalTarget, externalTarget]);
      await preview(internalTarget, 2, 0);
      await preview(externalTarget, 2, 0);
      const liveBoth = 'Array.from(document.querySelectorAll(".live-target-speed"), node => node.textContent).filter(text => text.startsWith("复制写入 ")).length === 2';
      const progressValues = 'Array.from(document.querySelectorAll(".transfer-target progress"), bar => bar.value)';
      await click('开始复制');
      await wait(liveBoth);
      await click('暂停');
      await queueState('已暂停');
      await new Promise(resolve => setTimeout(resolve, 150));
      const paused = await inspect(progressValues);
      await new Promise(resolve => setTimeout(resolve, 450));
      assert.deepEqual(await inspect(progressValues), paused);
      await click('继续');
      await queueState('已完成');
      checkedOutputs(internalTarget);
      checkedOutputs(externalTarget);
      const dual = JSON.parse(await downloadReport('dual', 'JSON'));
      assert.deepEqual(dual.outcomes.map(row => [row.target, row.status]).sort(), [
        ['matrix-target-0', 'verified'], ['matrix-target-0', 'verified'],
        ['matrix-target-1', 'verified'], ['matrix-target-1', 'verified'],
      ]);

      const cancelled = [join(internalTarget, 'cancel'), join(externalTarget, 'cancel')];
      for (const folder of cancelled) putFile(folder, smallPath, small);
      await queueFixture(cancelled);
      await click('开始复制');
      await wait(liveBoth);
      await click('暂停');
      await queueState('已暂停');
      await click('取消任务');
      await queueState('已停止');
      for (const folder of cancelled) {
        assert.equal(digest(readFileSync(join(folder, smallPath))), digest(small));
        assert.deepEqual(readdirSync(folder), ['notes']);
      }
      const stopped = JSON.parse(await downloadReport('dual-cancel', 'JSON'));
      assert.deepEqual(stopped.outcomes.map(row => row.status).sort(), ['cancelled', 'cancelled', 'reused', 'reused']);
      await click('重置任务');
      await queueState('待执行');
      assert.equal(await inspect('Boolean(document.querySelector(".speed-chart"))'), false);
      for (const folder of cancelled) {
        await preview(folder, 1, 1);
        assert.equal(digest(readFileSync(join(folder, smallPath))), digest(small));
      }

      await click('开始复制');
      await queueState('已完成');
      for (const folder of cancelled) checkedOutputs(folder);
      const restarted = JSON.parse(await downloadReport('dual-restarted', 'JSON'));
      assert.deepEqual(restarted.outcomes.map(row => row.status).sort(), ['reused', 'reused', 'verified', 'verified']);

      const conflictTarget = join(externalTarget, 'conflict');
      const originalContent = Buffer.alloc(small.length, 0x42);
      putFile(conflictTarget, smallPath, originalContent);
      const conflicted = join(conflictTarget, smallPath);
      const originalTime = statSync(conflicted).mtimeMs;
      await queueFixture([conflictTarget]);
      await preview(conflictTarget, 1, 1);
      await click('开始复制');
      await queueState('未完成');
      assert.deepEqual(await inspect(outcomeLabels), ['失败', '校验通过'].sort());
      await wait('Array.from(document.querySelectorAll(".table td[title]")).some(cell => cell.title.includes("原文件已保留"))');
      assert.equal(digest(readFileSync(conflicted)), digest(originalContent));
      assert.equal(statSync(conflicted).mtimeMs, originalTime);
      assert.equal(digest(readFileSync(join(conflictTarget, largePath))), digest(large));
      const conflict = JSON.parse(await downloadReport('conflict', 'JSON'));
      const conflictRow = conflict.outcomes.find(row => row.status === 'failed');
      assert.match(conflictRow?.error ?? '', /已有目标文件内容不同.*原文件已保留/);
      assert.equal(conflictRow.source_checksums['SHA-256'], digest(small));
      assert.equal(conflictRow.target_checksums['SHA-256'], digest(originalContent));
      assert.equal(await inspect('document.querySelectorAll(".file-hash[data-comparison=mismatch]").length'), 2);
      const mediaTarget = join(root, 'media-target');
      mkdirSync(mediaTarget);
      const mediaWorkflow = workflowFor([mediaTarget]);
      mediaWorkflow.nodes = mediaWorkflow.nodes.map(node => node.id === 'matrix-source'
        ? { ...node, kind: 'media', value: '' } : node);
      mediaWorkflow.nodes.push({ id: 'media-camera', kind: 'camera', value: '', x: 340, y: 240 });
      mediaWorkflow.edges.push({ id: 'media-camera-file', source: 'matrix-source', target: 'media-camera', targetHandle: 'files' });
      await click('工作流');
      await openFixture(mediaWorkflow);
      await wait('document.querySelector(".kind-media")?.textContent.includes("暂无可用介质")');
      const card = {
        id: 'test-card', root: matrixSource, type: 'sd', bus: 'SD', mediaModel: 'Test SD', mediaSerial: 'CARD-001',
        deviceModel: 'Test SD', deviceSerial: 'CARD-001',
      };
      simulatedMedia = [card];
      const mediaSelect = 'document.querySelector(\'select[aria-label="来源拍摄介质"]\')';
      await wait(mediaSelect + '?.options.length === 2');
      await inspect(`(() => {
        const select = ${mediaSelect};
        select.selectedIndex = 1;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await wait('document.querySelector(".kind-media")?.textContent.includes("CARD-001")');
      await wait('document.querySelector(".kind-camera [role=status]")?.textContent === "未识别到 Sony 卡目录"');
      simulatedMedia = [{ ...card, mediaModel: null, mediaSerial: null, deviceModel: 'Sony DSC', deviceSerial: 'DSC-USB-001' }];
      await wait('document.querySelector(".kind-media")?.textContent.includes("系统设备序列号：DSC-USB-001")');
      assert.ok(await inspect('document.querySelector(".kind-media")?.textContent.includes("介质序列号：未读取")'));
      simulatedMedia = [card];
      await wait('document.querySelector(".kind-media")?.textContent.includes("介质序列号：CARD-001")');
      await click('加入队列');
      await queueState('待执行');
      await click('开始复制');
      await queueState('已完成');
      checkedOutputs(mediaTarget);
      const mediaReport = JSON.parse(await downloadReport('media', 'JSON'));
      assert.equal(mediaReport.media[0].mediaSerial, 'CARD-001');
      assert.equal(mediaReport.media[0].mediaModel, 'Test SD');
      const html = await downloadReport('media', 'HTML');
      assert.ok(html.includes('来源拍摄介质') && html.includes('CARD-001'));

      const listSource = join(root, 'long-queue-source');
      const listTarget = join(root, 'long-queue-target');
      mkdirSync(listSource);
      mkdirSync(listTarget);
      for (let index = 0; index < 205; index++) writeFileSync(join(listSource, `a-${String(index).padStart(3, '0')}.bin`), '');
      writeFileSync(join(listSource, 'z-last.bin'), Buffer.alloc(4 * 1024 * 1024, 7));
      const longQueue = workflowFor([listTarget]);
      longQueue.nodes = longQueue.nodes.map(node => node.id === 'matrix-source' ? { ...node, value: listSource } : node);
      await click('工作流');
      await openFixture(longQueue);
      await click('加入队列');
      await queueState('待执行');
      const list = 'document.querySelector(".queue-detail .table")';
      const follow = 'document.querySelector(".file-list-follow input")';
      assert.equal(await inspect(list + '.querySelector("table").getAttribute("aria-rowcount")'), '207');
      assert.ok(await inspect('!document.querySelector(".queue-detail").innerText.includes("显示前 200 条输出")'));
      const firstColumn = '.table th:first-child';
      const initialWidth = await inspect(`document.querySelector('${firstColumn}').getBoundingClientRect().width`);
      await drag('.table th:first-child .file-column-resize', 45, 0);
      assert.ok(await inspect(`document.querySelector('${firstColumn}').getBoundingClientRect().width > ${initialWidth + 30}`));
      await inspect(follow + '.click()');
      await inspect(list + '.scrollTop = ' + list + '.scrollHeight');
      const lastRow = '.table .file-list-row[aria-rowindex="207"]';
      await wait(`document.querySelector(${JSON.stringify(lastRow)})?.textContent.includes("z-last.bin")`);
      await inspect(list + '.scrollTop = 0');
      await click('开始复制');
      await wait('Array.from(document.querySelectorAll(".transfer-file")).some(file => file.textContent.includes("z-last.bin"))');
      assert.equal(await inspect(list + '.scrollTop'), 0);
      await inspect(follow + '.click()');
      await wait(`(() => {
        const list = ${list};
        const row = document.querySelector(${JSON.stringify(lastRow)});
        return row && list.scrollTop > 0 && row.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom;
      })()`);
      await queueState('已完成');
      BrowserWindow.fromWebContents(contents).setSize(760, 560);
      await wait('window.innerHeight <= 560');
      await inspect('document.querySelector(".file-status-guide summary").click()');
      const layout = await inspect(`(() => {
        const detail = document.querySelector('.queue-detail');
        const list = detail.querySelector('.table');
        const guide = detail.querySelector('.file-status-guide');
        return { overflow: getComputedStyle(detail).overflowY, outer: detail.clientHeight, scroll: detail.scrollHeight,
          height: list.clientHeight, listScroll: list.scrollHeight, bottom: list.getBoundingClientRect().bottom, window: innerHeight,
          sizes: ['cancelled', 'await_verify'].map(state => guide.querySelector('[data-state=' + state + '] svg').getBoundingClientRect().width),
          children: Array.from(detail.children, child => [child.className, child.getBoundingClientRect().height]),
        };
      })()`);
      assert.equal(layout.overflow, 'hidden');
      assert.ok(layout.scroll <= layout.outer + 1 && layout.height > 60 && layout.listScroll > layout.height &&
        layout.bottom <= layout.window, JSON.stringify(layout));
      assert.deepEqual(layout.sizes, [16, 16]);
      done('PASS: dialog-free execution, bounded queue layout and consistent status icons; resizable columns, full file list and auto-scroll; media discovery, selected source and HTML/JSON media reports; Sony category ports and saved routing; single-target empty/partial/full, JSON and HTML reports, dual-target controls and collision protection; endpoint reconnect/disconnect and source tree edge ports; group rename persisted, pause/resume and cancel while paused, filled speed chart, two-axis and tree resize, canvas tools, spaced alignment, full-width group drag and per-edge selection; queue alerts, button cursors, verification states, cancellation and speed chart; source tree output position and routing, all node library names, official and legacy node titles, root and planned folder routing, output tree siblings, children and reorder, workflow file and library round trips, legacy paths, real copies and verification.', 0);
    } catch (error) {
      done(error.stack, 1);
    }
  });
});

const profile = join(root, 'profile');
mkdirSync(profile);
const setPath = app.setPath.bind(app);
app.setPath = (name, path) => setPath(name, name === 'userData' ? profile : path);
app.once('will-quit', () => {
  if (!require('node:fs').existsSync(process.env.FILEBRAID_COPY_SMOKE_RESULT)) {
    writeFileSync(process.env.FILEBRAID_COPY_SMOKE_RESULT, 'Electron quit before UI verification.');
    process.exitCode = 1;
  }
});
require('./main.cjs');
app.setPath = setPath;
