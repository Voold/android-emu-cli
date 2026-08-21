import test from 'node:test';
import assert from 'node:assert/strict';
import * as mitmMenu from '../src/menus/mitm.js';

test('stopMitmProcessesAction reports an empty process list without confirmation', async () => {
  assert.equal(typeof mitmMenu.stopMitmProcessesAction, 'function');
  const messages = [];
  const result = await mitmMenu.stopMitmProcessesAction({
    listProcesses: () => [],
    confirmStop: async () => { throw new Error('must not confirm'); },
    stopProcesses: async () => { throw new Error('must not stop'); },
    warn: (message) => messages.push(message),
    pause: async () => {},
  });
  assert.deepEqual(result, { status: 'empty' });
  assert.match(messages[0], /не найдены/iu);
});

test('stopMitmProcessesAction cancels without signalling processes', async () => {
  assert.equal(typeof mitmMenu.stopMitmProcessesAction, 'function');
  const result = await mitmMenu.stopMitmProcessesAction({
    listProcesses: () => [{ pid: 41, name: 'mitmproxy' }],
    confirmStop: async () => false,
    stopProcesses: async () => { throw new Error('must not stop'); },
    pause: async () => {},
  });
  assert.deepEqual(result, { status: 'cancelled' });
});

test('stopMitmProcessesAction confirms and reports all terminated processes', async () => {
  assert.equal(typeof mitmMenu.stopMitmProcessesAction, 'function');
  const messages = [];
  let confirmedCount;
  const result = await mitmMenu.stopMitmProcessesAction({
    listProcesses: () => [{ pid: 41, name: 'mitmproxy' }, { pid: 42, name: 'mitmdump' }],
    confirmStop: async (processes) => { confirmedCount = processes.length; return true; },
    stopProcesses: async () => ({ found: 2, terminated: 2, forced: 1 }),
    success: (message) => messages.push(message),
    pause: async () => {},
  });
  assert.equal(confirmedCount, 2);
  assert.deepEqual(result, { status: 'stopped', found: 2, terminated: 2, forced: 1 });
  assert.match(messages[0], /2/);
  assert.match(messages[0], /принудительно: 1/iu);
});

test('stopMitmProcessesAction keeps a stop failure visible', async () => {
  assert.equal(typeof mitmMenu.stopMitmProcessesAction, 'function');
  const errors = [];
  const result = await mitmMenu.stopMitmProcessesAction({
    listProcesses: () => [{ pid: 41, name: 'mitmproxy' }],
    confirmStop: async () => true,
    stopProcesses: async () => { throw new Error('permission denied'); },
    error: (message) => errors.push(message),
    pause: async () => {},
  });
  assert.deepEqual(result, { status: 'error', message: 'permission denied' });
  assert.match(errors[0], /permission denied/);
});
