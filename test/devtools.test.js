import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAdbDevices,
  parseAvdName,
  parseDevToolsTargets,
  parseDevToolsSockets,
  buildDevToolsUrl,
} from '../src/devtools.js';

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
    buildDevToolsUrl(9222, { webSocketDebuggerUrl: 'ws://localhost/devtools/page/ABC' }),
    'devtools://devtools/bundled/inspector.html?ws=localhost:9222/devtools/page/ABC'
  );
});

test('buildDevToolsUrl prefers the version-matched frontend returned by WebView', () => {
  const frontendUrl =
    'https://chrome-devtools-frontend.appspot.com/serve_rev/@abc123/inspector.html?ws=127.0.0.1:9222/devtools/page/ABC';

  assert.equal(
    buildDevToolsUrl(9222, {
      devtoolsFrontendUrl: frontendUrl,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
    }),
    frontendUrl
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
