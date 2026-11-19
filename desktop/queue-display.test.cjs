const assert = require('node:assert/strict');
const { test } = require('node:test');
const { addSpeedSample, continuousSpeed, speedIntervals, stableSpeedEnd } = require('../src/copy-speed.ts');
const { displayPath } = require('../src/path-display.ts');
const { transferSpeedAxis } = require('../src/speed-axis.ts');

test('the curve begins at the first measured rate and continues through idle buckets', () => {
  let samples = addSpeedSample(new Map(), 0.125, 100, 800);
  samples = addSpeedSample(samples, 1, 100, 400);
  const intervals = speedIntervals([samples], 0, 1.25);
  assert.deepEqual(intervals.map(({ speed }) => speed), [800, 0, 0, 400, 0]);
  assert.deepEqual(continuousSpeed(intervals).map(interval => interval.speed), [800, 0, 0, 400, 0]);
  assert.deepEqual(continuousSpeed(speedIntervals([samples], 0.25, 1.25)).map(interval => interval.speed), [400, 0]);
});

test('withholds the latest bucket until both active targets have reported', () => {
  assert.equal(stableSpeedEnd(13.2, true, [12.95, 12.4]), 12.25);
  assert.equal(stableSpeedEnd(13.2, true, [12.95, 12.8]), 12.5);
  assert.equal(stableSpeedEnd(13.2, false, [12.95, 12.4]), 13.2);
});

test('sums concurrent target rates and clips the rolling window', () => {
  const old = addSpeedSample(new Map(), 0.25, 25, 100);
  const first = addSpeedSample(old, 63, 125, 500);
  const second = addSpeedSample(new Map(), 63, 250, 1000);
  assert.equal(first.has(0), false);
  assert.deepEqual(speedIntervals([first, second], 62.875, 63.125), [
    { start: 62.875, end: 63, speed: 1500 },
    { start: 63, end: 63.125, speed: 0 },
  ]);
});

test('the live speed scale shrinks after a historical spike and expands as recent traffic rises', () => {
  const mib = 1024 ** 2;
  const points = [
    { end: 20, speed: 1200 * mib },
    { end: 57, speed: 18 * mib },
    { end: 58, speed: 20 * mib },
    { end: 59, speed: 19 * mib },
  ];
  const low = transferSpeedAxis(points, 60, 20 * mib);
  const high = transferSpeedAxis([...points, { end: 67, speed: 180 * mib }, { end: 68, speed: 190 * mib }], 70, 190 * mib);
  assert.equal(low.unit, 'MiB/s');
  assert.ok(low.maximum > 20 * mib && low.maximum < 100 * mib);
  assert.ok(high.maximum > low.maximum);
  assert.ok(transferSpeedAxis(points, 60).maximum >= 1200 * mib);
});

test('formats Windows drive and UNC paths without changing other namespaces', () => {
  assert.equal(displayPath('\\\\?\\D:\\测试\\文件.txt'), 'D:\\测试\\文件.txt');
  assert.equal(displayPath('\\\\?\\UNC\\host\\share\\文件.txt'), '\\\\host\\share\\文件.txt');
  assert.equal(displayPath('\\\\?\\Volume{token}\\文件.txt'), '\\\\?\\Volume{token}\\文件.txt');
  assert.equal(displayPath('/mnt/素材/文件.txt'), '/mnt/素材/文件.txt');
});

test('deferred verification puts a fully written batch at exactly half by bytes', () => {
  const { fileWork } = require('../src/transfer-progress.ts');
  const large = { bytes: 900, existing: false, verified_by: ['SHA-256'] };
  const small = { bytes: 100, existing: false, verified_by: ['SHA-256'] };
  assert.deepEqual(fileWork(large, false, undefined, { phase: 'copy', bytes: 450 }, false), { total: 1800, done: 450 });
  const staged = [fileWork(large, false, undefined, undefined, true), fileWork(small, false, undefined, undefined, true)];
  assert.equal(staged.reduce((sum, row) => sum + row.done, 0) / staged.reduce((sum, row) => sum + row.total, 0), 0.5);
  assert.deepEqual(fileWork(large, false, undefined, { phase: 'verify', bytes: 450 }, true), { total: 1800, done: 1350 });
  assert.deepEqual(fileWork(large, false, 'cancelled', undefined, false), { total: 1800, done: 0 });
  assert.deepEqual(fileWork(small, true, undefined, { phase: 'source', bytes: 50 }, false), { total: 200, done: 50 });
  assert.deepEqual(fileWork({ ...small, verified_by: [] }, false, 'copied', undefined, false), { total: 100, done: 100 });
});
