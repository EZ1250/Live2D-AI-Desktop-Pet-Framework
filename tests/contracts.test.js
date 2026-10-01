const test = require('node:test');
const assert = require('node:assert/strict');

const contracts = require('../dist/shared/contracts.js');

test('IPC channel constants are non-empty and unique', () => {
  const entries = Object.entries(contracts).filter(([key, value]) => key.startsWith('IPC_') && typeof value === 'string');
  assert.ok(entries.length > 0, 'should export IPC_ constants');

  const values = entries.map(([, value]) => value.trim());
  values.forEach((value) => assert.ok(value.length > 0, 'IPC channel should not be empty'));

  const uniq = new Set(values);
  assert.equal(uniq.size, values.length, 'IPC channel values should be unique');
});
