const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preview } = require('./preview.cjs');

test('passes a UTF-8 workflow to the child and decodes its response', async () => {
  const echo = 'let body = ""; process.stdin.setEncoding("utf8").on("data", s => body += s).on("end", () => console.log(body));';
  const workflow = { version: 1, name: '影视拷卡' };
  assert.deepEqual(await preview(process.execPath, ['-e', echo], workflow), workflow);
});

test('propagates a planner failure instead of returning an empty successful plan', async () => {
  await assert.rejects(
    preview(process.execPath, ['-e', 'console.error("目标路径冲突"); process.exitCode = 1;'], {}),
    /目标路径冲突/,
  );
});
