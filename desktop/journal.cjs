const { open, mkdir, readFile, readdir, stat } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

async function createJournal(directory, request, endpoints) {
  await mkdir(directory, { recursive: true });
  const id = Date.now() + '-' + randomUUID();
  const handle = await open(join(directory, id + '.jsonl'), 'ax');
  let pending = Promise.resolve();
  function append(event) {
    pending = pending.then(async () => {
      await handle.writeFile(JSON.stringify(event) + '\n', 'utf8');
      await handle.sync();
    });
    return pending;
  }
  try {
    await append({ type: 'started', version: 1, id, date: new Date().toISOString(), request, endpoints });
  } catch (error) {
    await handle.close();
    throw error;
  }
  return { append, async close() {
    try { await pending; }
    finally { await handle.close(); }
  } };
}

async function latestJournal(directory) {
  let names;
  try { names = await readdir(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  for (const name of names.filter(name => /^\d+-[a-f0-9-]+\.jsonl$/.test(name)).sort().reverse()) {
    const text = await readFile(join(directory, name), 'utf8');
    // A host crash can interrupt the last write. Only consume complete lines.
    const lines = text.split('\n');
    lines.pop();
    if (lines.length === 0) continue;
    const [header, ...events] = lines.map(line => JSON.parse(line));
    if (header.type !== 'started' || header.version !== 1) throw new Error('无法读取任务记录版本。');
    const outcomes = events.filter(event => event.type === 'file').map(event => event.outcome);
    const last = events.at(-1);
    return { ...header, outcomes, status: last?.type === 'finished' ? last.status : 'interrupted' };
  }
  return null;
}

async function identifyEndpoints(workflow) {
  const sourceIds = new Set(workflow.nodes.filter(node => node.kind === 'source').map(node => node.id));
  const linkedTrees = new Set(workflow.edges.filter(edge =>
    sourceIds.has(edge.source) && (edge.sourceHandle ?? 'out') === 'out' && (edge.targetHandle ?? 'files') === 'files',
  ).map(edge => edge.target));
  const endpoints = workflow.nodes.filter(node => node.kind === 'source' || node.kind === 'target' ||
    (node.kind === 'tree' && !linkedTrees.has(node.id)));
  return Promise.all(endpoints.map(async node => {
    const info = await stat(node.value, { bigint: true });
    if (!info.isDirectory()) throw new Error('任务路径不是目录：' + node.value);
    return {
      id: node.id, kind: node.kind, path: node.value,
      identity: info.dev !== 0n && info.ino !== 0n ? `${info.dev}:${info.ino}` : null,
    };
  }));
}

module.exports = { createJournal, latestJournal, identifyEndpoints };
