const { spawn } = require('node:child_process');

function preview(executable, args, workflow) {
  const input = JSON.stringify(workflow);
  if (Buffer.byteLength(input) > 1_000_000) {
    return Promise.reject(new Error('工作流超过 1 MB。'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('扫描超时。请缩小来源范围后重试。'));
    }, 60_000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 16_000_000) {
        child.kill();
        reject(new Error('预览结果超过大小限制。'));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.once('error', error => {
      clearTimeout(timeout);
      reject(new Error(error.code === 'ENOENT' ? '未找到 Rust 引擎，请先构建引擎。' : error.message));
    });
    child.stdin.on('error', () => { /* The child exit reports rejected input. */ });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || '预览引擎异常退出。'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('预览引擎返回了无法读取的结果。'));
      }
    });
    child.stdin.end(input);
  });
}

module.exports = { preview };
