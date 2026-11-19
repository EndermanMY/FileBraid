const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const electron = require('electron');

const root = mkdtempSync(join(tmpdir(), 'filebraid-queue-test-'));
const resultFile = join(root, 'result.txt');
try {
  const result = spawnSync(electron, ['--headless', '--disable-gpu', join(__dirname, 'queue-smoke.cjs')], {
    encoding: 'utf8',
    env: { ...process.env, FILEBRAID_QUEUE_TEST_ROOT: root, FILEBRAID_COPY_SMOKE_RESULT: resultFile },
    timeout: 75_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  let message;
  try { message = readFileSync(resultFile, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (result.status !== 0 || !message?.startsWith('PASS:')) {
    throw new Error([message, result.stderr, `Electron exit: ${result.status}`].filter(Boolean).join('\n'));
  }
  process.stdout.write(message + '\n');
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
