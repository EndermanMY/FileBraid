const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identifyMedia, resolveMediaWorkflow } = require('./shooting-media.cjs');

test('lists only shooting media and describes USB bridge identifiers separately', async () => {
  const disk = (letter, bus, model, extra = {}) => ({
    letter, bus, model, serial: 'device-' + letter, volumeId: 'volume-' + letter,
    diskId: 'disk-' + letter, size: 1024, ...extra,
  });
  const media = await identifyMedia([
    disk('C', 'SD', 'SYSTEM', { system: true }),
    disk('D', 'NVMe', 'Generic SSD'),
    disk('E', 'USB', 'Generic storage'),
    disk('F', 'SD', 'SDSD128'),
    disk('G', 'USB', 'CFexpress Type A Reader'),
    disk('H', 'USB', 'Recorder SSD'),
    disk('I', 'USB', 'CFexpress Type B'),
  ], async root => root === 'H:\\');
  assert.deepEqual(media.map(({ root, type }) => [root, type]), [
    ['F:\\', 'sd'], ['G:\\', 'cfa'], ['H:\\', 'shooting-storage'],
  ]);
  assert.equal(media[0].mediaModel, 'SDSD128');
  assert.equal(media[0].mediaSerial, 'device-F');
  assert.equal(media[1].mediaModel, null);
  assert.equal(media[1].mediaSerial, null);
  assert.equal(media[1].deviceSerial, 'device-G');
});

test('resolves only the selected mounted volume, refuses a different card on the same drive', async () => {
  const card = { id: 'selected-id', root: 'E:\\', type: 'sd', mediaSerial: 'card-serial' };
  const flow = { version: 4, nodes: [{ id: 'media', kind: 'media', value: JSON.stringify({ id: card.id, root: card.root }) }], edges: [] };
  const result = await resolveMediaWorkflow(flow, async () => [card]);
  assert.deepEqual(result.workflow.nodes, [{ id: 'media', kind: 'source', value: 'E:\\' }]);
  assert.deepEqual(result.media, [{ ...card, node: 'media' }]);
  assert.equal(flow.nodes[0].kind, 'media');
  await assert.rejects(() => resolveMediaWorkflow(flow, async () => [{ ...card, id: 'different-id' }]), /已更换/);
});
