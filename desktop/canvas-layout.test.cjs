const assert = require('node:assert/strict');
const { test } = require('node:test');
const { alignCanvas } = require('../src/canvas-layout.ts');

const box = (id, x, y, width = 100, height = 60) => ({ id, x, y, width, height });

test('left alignment closes horizontal gaps and retains the existing lanes and order', () => {
  const positions = alignCanvas([
    box('input', 20, 10), box('second', 240, 10), box('branch', 240, 160), box('output', 510, 10),
  ], [], 'left');
  assert.deepEqual(Object.fromEntries(positions), {
    input: { x: 20, y: 10 }, second: { x: 152, y: 10 },
    branch: { x: 152, y: 160 }, output: { x: 284, y: 10 },
  });
});

test('left alignment keeps horizontally separated linked nodes in different columns', () => {
  const positions = alignCanvas([box('source', 20, 10), box('next', 240, 180)], [], 'left', [
    { source: 'source', target: 'next' },
  ]);
  assert.deepEqual(Object.fromEntries(positions), { source: { x: 20, y: 10 }, next: { x: 152, y: 180 } });
});

test('alignment leaves unselected nodes in place and does not pack over them', () => {
  const positions = alignCanvas([box('input', 20, 10), box('output', 510, 10)], [box('fixed', 150, 10)], 'left');
  assert.deepEqual(Object.fromEntries(positions), { input: { x: 18, y: 10 }, output: { x: 282, y: 10 } });
});
