const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

function startTransfer(executable, request, onProgress, verifyOnly = false) {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) >= 1_000_000) throw new Error('工作流超过 1 MB。');
  const child = spawn(executable, [verifyOnly ? 'verify' : 'execute'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [];
  let diagnostics = '';
  let running = true;
  const result = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => output.push(chunk));
    createInterface({ input: child.stderr }).on('line', line => {
      let event;
      try { event = JSON.parse(line); }
      catch { diagnostics = (diagnostics + line + '\n').slice(-4096); return; }
      onProgress(event);
    });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', code => {
      running = false;
      if (code !== 0) {
        reject(new Error(diagnostics.trim() || '复制引擎异常退出。请重新预览并检查目标。'));
        return;
      }
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8'))); }
      catch { reject(new Error('无法读取复制结果。请重新预览并检查目标。')); }
    });
    child.stdin.write(input + '\n');
  });
  const command = (action) => {
    if (!running || !child.stdin.writable) return false;
    if (action === 'cancel') child.stdin.end();
    else child.stdin.write(action + '\n');
    return true;
  };
  return { result, cancel: () => command('cancel'), pause: () => command('pause'), resume: () => command('resume') };
}

module.exports = { startTransfer };
