import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  buildMitmArgs,
  parseCliArgs,
  readMitmConfig,
  writeMitmConfig,
  resetMitmConfig,
  validateScriptPaths,
  isPortAvailable,
  findAvailablePort,
} from '../src/mitm.js';

test('parseCliArgs preserves quoted arguments and treats shell operators as plain text', () => {
  assert.deepEqual(parseCliArgs('--set "flow_detail=3" --set label=\'hello world\' "$(touch /tmp/nope)"'), [
    '--set',
    'flow_detail=3',
    '--set',
    'label=hello world',
    '$(touch /tmp/nope)',
  ]);
});

test('parseCliArgs rejects an unfinished quote', () => {
  assert.throws(() => parseCliArgs('--set "broken'), /Незакрытая кавычка/);
});

test('buildMitmArgs emits one script flag per path and all configured options', () => {
  assert.deepEqual(
    buildMitmArgs({
      scripts: ['/tmp/one addon.py', '/tmp/two.py'],
      listenPort: 8080,
      mode: 'upstream:http://proxy.test:3128',
      sslInsecure: true,
      blockGlobal: false,
      verbosity: 2,
      customArgs: '--set connection_strategy=lazy',
    }),
    [
      '-s', '/tmp/one addon.py',
      '-s', '/tmp/two.py',
      '--listen-port', '8080',
      '--mode', 'upstream:http://proxy.test:3128',
      '--ssl-insecure',
      '--set', 'block_global=false',
      '-vv',
      '--set', 'connection_strategy=lazy',
    ]
  );
});

test('mitm configuration survives write, read, and reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-mitm-test-'));
  const configPath = path.join(dir, 'mitm-config.json');
  const config = { scripts: ['/tmp/addon.py'], listenPort: 8080, customArgs: '--anticache' };

  writeMitmConfig(config, configPath);
  assert.deepEqual(readMitmConfig(configPath), config);

  resetMitmConfig(configPath);
  assert.equal(readMitmConfig(configPath), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateScriptPaths rejects a missing saved addon script', () => {
  assert.throws(
    () => validateScriptPaths(['/definitely/missing/android-emu-addon.py']),
    /Скрипт не найден/
  );
});

test('isPortAvailable detects a port occupied by another process', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;

  assert.equal(await isPortAvailable(port, '127.0.0.1'), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortAvailable(port, '127.0.0.1'), true);
});

test('findAvailablePort skips an occupied starting port', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const occupiedPort = server.address().port;

  const availablePort = await findAvailablePort(occupiedPort, '127.0.0.1');
  assert.notEqual(availablePort, occupiedPort);
  assert.equal(await isPortAvailable(availablePort, '127.0.0.1'), true);
  await new Promise((resolve) => server.close(resolve));
});
