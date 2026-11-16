const { mkdir, readdir, readFile, rename, stat, unlink, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');

const workflowId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const limit = 1_000_000;

function libraryWorkflowPath(directory, id) {
  if (typeof id !== 'string' || !workflowId.test(id)) throw new Error('工作流编号无效。');
  return join(directory, id + '.json');
}

async function readLibraryWorkflow(directory, id) {
  const file = libraryWorkflowPath(directory, id);
  if ((await stat(file)).size > limit + 1024) throw new Error('工作流文件过大。');
  const { name, created, workflow } = JSON.parse(await readFile(file, 'utf8'));
  if (typeof name !== 'string' || typeof created !== 'string' ||
    !workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) throw new Error('工作流文件格式无效。');
  return { id, name, created, workflow };
}

async function listLibraryWorkflows(directory) {
  let files;
  try { files = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const items = [];
  for (const file of files) {
    const id = file.name.slice(0, -5);
    if (!file.isFile() || !file.name.endsWith('.json') || !workflowId.test(id)) continue;
    try {
      const { name, created } = await readLibraryWorkflow(directory, id);
      items.push({ id, name, created });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return items.sort((a, b) => b.created.localeCompare(a.created) || a.name.localeCompare(b.name));
}

async function saveLibraryWorkflow(directory, name, workflow) {
  const label = typeof name === 'string' ? name.trim() : '';
  if (!label || label.length > 80) throw new Error('请输入 1 至 80 个字符的工作流名称。');
  if (!workflow || workflow.version !== 3 || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
    throw new Error('工作流格式无效。');
  }
  if (Buffer.byteLength(JSON.stringify(workflow)) > limit) throw new Error('工作流超过 1 MB。');
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const created = new Date().toISOString();
  const file = libraryWorkflowPath(directory, id);
  const temporary = file + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ name: label, created, workflow }), { flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { id, name: label, created };
}

const removeLibraryWorkflow = (directory, id) => unlink(libraryWorkflowPath(directory, id));
module.exports = { listLibraryWorkflows, readLibraryWorkflow, saveLibraryWorkflow, removeLibraryWorkflow };
