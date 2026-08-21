import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  parseAdbDevices,
  parseAvdName,
  parseDevToolsTargets,
  parseDevToolsSockets,
  buildDevToolsUrl,
  listDeviceTargets,
} from '../src/devtools.js';

async function listenHttp(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeHttp(server) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

test('parseAdbDevices returns only online emulator serials', () => {
  const output = [
    'List of devices attached',
    'emulator-5554 device product:sdk_gphone model:sdk_gphone transport_id:1',
    'emulator-5556 offline transport_id:2',
    'R58M123 device product:phone transport_id:3',
    '',
  ].join('\n');

  assert.deepEqual(parseAdbDevices(output), ['emulator-5554']);
});

test('parseAvdName extracts the AVD name returned by the emulator console', () => {
  assert.equal(parseAvdName('Pixel_8_Pro\nOK\n'), 'Pixel_8_Pro');
});

test('parseDevToolsTargets keeps inspectable page and webview targets', () => {
  const targets = parseDevToolsTargets(JSON.stringify([
    { id: 'page-1', type: 'page', title: 'Example', url: 'https://example.com', webSocketDebuggerUrl: 'ws://localhost/devtools/page/1' },
    { id: 'worker-1', type: 'service_worker', title: 'Worker', url: 'https://example.com/sw.js' },
    { id: 'webview-1', type: 'webview', title: '', url: 'https://app.test', webSocketDebuggerUrl: 'ws://localhost/devtools/page/2' },
  ]));

  assert.deepEqual(targets.map(({ id, title }) => ({ id, title })), [
    { id: 'page-1', title: 'Example' },
    { id: 'webview-1', title: 'https://app.test' },
  ]);
});

test('buildDevToolsUrl opens the selected target through local forwarded port', () => {
  assert.equal(
    buildDevToolsUrl(9333, { webSocketDebuggerUrl: 'ws://localhost/devtools/page/ABC' }, 'relay-secret'),
    'devtools://devtools/bundled/inspector.html?ws=127.0.0.1:9333/devtools/page/ABC?relayToken=relay-secret'
  );
});

test('buildDevToolsUrl routes a version-matched frontend through the relay', () => {
  const frontendUrl =
    'https://chrome-devtools-frontend.appspot.com/serve_rev/@abc123/inspector.html?ws=127.0.0.1:9222/devtools/page/ABC';

  assert.equal(
    buildDevToolsUrl(9333, {
      devtoolsFrontendUrl: frontendUrl,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
    }, 'relay-secret'),
    'https://chrome-devtools-frontend.appspot.com/serve_rev/@abc123/inspector.html?ws=127.0.0.1%3A9333%2Fdevtools%2Fpage%2FABC%3FrelayToken%3Drelay-secret'
  );
});

test('parseDevToolsSockets finds Chrome and application WebView sockets', () => {
  const output = [
    '00000000: 00000002 00000000 00010000 0001 01 12345 @chrome_devtools_remote',
    '00000000: 00000002 00000000 00010000 0001 01 12346 @webview_devtools_remote_8123',
    '00000000: 00000002 00000000 00010000 0001 01 12347 @other_socket',
  ].join('\n');

  assert.deepEqual(parseDevToolsSockets(output), [
    'chrome_devtools_remote',
    'webview_devtools_remote_8123',
  ]);
});

test('listDeviceTargets skips a stale socket and continues with the working WebView', async (t) => {
  const stale = http.createServer(() => {});
  const working = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{
      id: 'working-page',
      type: 'page',
      title: 'Working WebView',
      url: 'https://example.test',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/working-page',
    }]));
  });
  const stalePort = await listenHttp(stale);
  const workingPort = await listenHttp(working);
  t.after(() => closeHttp(stale));
  t.after(() => closeHttp(working));

  const runCommand = (_command, args) => {
    if (args.includes('/proc/net/unix')) {
      return [
        '@webview_devtools_remote_1111',
        '@webview_devtools_remote_2222',
      ].join('\n');
    }
    const socket = args.at(-1);
    if (socket === 'localabstract:webview_devtools_remote_1111') return String(stalePort);
    if (socket === 'localabstract:webview_devtools_remote_2222') return String(workingPort);
    throw new Error(`Неожиданная команда: ${args.join(' ')}`);
  };

  const targets = await listDeviceTargets('emulator-5554', {
    runCommand,
    fetchImpl: fetch,
    timeoutMs: 50,
  });

  assert.deepEqual(targets.map(({ id, socket }) => ({ id, socket })), [{
    id: 'working-page',
    socket: 'webview_devtools_remote_2222',
  }]);
});
