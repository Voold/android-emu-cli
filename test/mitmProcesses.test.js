import test from 'node:test';
import assert from 'node:assert/strict';
import * as mitm from '../src/mitm.js';

test('listMitmProcesses returns only exact current-user mitm executable names', () => {
  assert.equal(typeof mitm.listMitmProcesses, 'function');
  const calls = [];
  const result = mitm.listMitmProcesses({
    uid: 501,
    run: (command, args) => {
      calls.push([command, args]);
      const name = args.at(-1);
      if (name === 'mitmproxy') return { status: 0, stdout: '41\n' };
      if (name === 'mitmdump') return { status: 0, stdout: '42\n43\n' };
      return { status: 1, stdout: '' };
    },
  });

  assert.deepEqual(result, [
    { pid: 41, name: 'mitmproxy' },
    { pid: 42, name: 'mitmdump' },
    { pid: 43, name: 'mitmdump' },
  ]);
  assert.deepEqual(calls.map(([, args]) => args), [
    ['-U', '501', '-x', 'mitmproxy'],
    ['-U', '501', '-x', 'mitmdump'],
    ['-U', '501', '-x', 'mitmweb'],
  ]);
});

test('findRunningMitm prefers the configured listener and otherwise the lowest port', () => {
  assert.equal(typeof mitm.findRunningMitm, 'function');
  const processes = [
    { pid: 41, name: 'mitmproxy' },
    { pid: 42, name: 'mitmdump' },
  ];
  const run = (_command, args) => {
    const pid = Number(args[args.indexOf('-p') + 1]);
    return pid === 41
      ? { status: 0, stdout: 'p41\nn*:9090\nn127.0.0.1:8181\n' }
      : { status: 0, stdout: 'p42\nn[::1]:8081\n' };
  };
  const dependencies = { listProcesses: () => processes, run };

  assert.deepEqual(mitm.findRunningMitm(9090, dependencies), {
    pid: 41,
    name: 'mitmproxy',
    port: 9090,
  });
  assert.deepEqual(mitm.findRunningMitm(7777, dependencies), {
    pid: 42,
    name: 'mitmdump',
    port: 8081,
  });
});

test('findRunningMitm ignores a mitm process without a TCP listener', () => {
  assert.equal(typeof mitm.findRunningMitm, 'function');
  assert.equal(mitm.findRunningMitm(8080, {
    listProcesses: () => [{ pid: 41, name: 'mitmproxy' }],
    run: () => ({ status: 1, stdout: '' }),
  }), null);
});

test('findRunningMitm never mistakes the mitmweb UI listener for its proxy port', () => {
  assert.deepEqual(mitm.findRunningMitm(8081, {
    listProcesses: () => [{ pid: 44, name: 'mitmweb' }],
    run: (command) => command === 'lsof'
      ? { status: 0, stdout: 'p44\nn127.0.0.1:8080\nn127.0.0.1:8081\n' }
      : { status: 0, stdout: '/opt/homebrew/bin/mitmweb --web-port 8081\n' },
  }), { pid: 44, name: 'mitmweb', port: 8080 });
});

test('stopAllMitmProcesses terminates every exact process and force-kills only survivors', async () => {
  assert.equal(typeof mitm.stopAllMitmProcesses, 'function');
  const snapshots = [
    [{ pid: 41, name: 'mitmproxy' }, { pid: 42, name: 'mitmdump' }, { pid: 43, name: 'mitmweb' }],
    [{ pid: 42, name: 'mitmdump' }],
    [],
  ];
  const signals = [];
  let sleeps = 0;

  const result = await mitm.stopAllMitmProcesses({
    listProcesses: () => snapshots.shift() ?? [],
    killProcess: (pid, signal) => signals.push([pid, signal]),
    sleep: async () => { sleeps += 1; },
  });

  assert.deepEqual(signals, [
    [41, 'SIGTERM'], [42, 'SIGTERM'], [43, 'SIGTERM'],
    [42, 'SIGKILL'],
  ]);
  assert.equal(sleeps, 2);
  assert.deepEqual(result, { found: 3, terminated: 3, forced: 1 });
});

test('stopAllMitmProcesses is a no-op when nothing is running', async () => {
  assert.equal(typeof mitm.stopAllMitmProcesses, 'function');
  const result = await mitm.stopAllMitmProcesses({
    listProcesses: () => [],
    killProcess: () => { throw new Error('must not signal'); },
  });
  assert.deepEqual(result, { found: 0, terminated: 0, forced: 0 });
});

test('stopAllMitmProcesses still signals other PIDs when one process rejects termination', async () => {
  const snapshots = [
    [{ pid: 41, name: 'mitmproxy' }, { pid: 42, name: 'mitmdump' }],
    [{ pid: 41, name: 'mitmproxy' }],
    [{ pid: 41, name: 'mitmproxy' }],
  ];
  const signals = [];
  await assert.rejects(
    () => mitm.stopAllMitmProcesses({
      listProcesses: () => snapshots.shift() ?? [],
      killProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === 41) throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      },
      sleep: async () => {},
    }),
    /41/
  );
  assert.deepEqual(signals, [
    [41, 'SIGTERM'],
    [42, 'SIGTERM'],
    [41, 'SIGKILL'],
  ]);
});
