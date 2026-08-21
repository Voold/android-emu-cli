import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';

const serverSockets = new WeakMap();

async function listen(server) {
  const sockets = new Set();
  serverSockets.set(server, sockets);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  server.close();
  await once(server, 'close');
}

test('relay removes browser Origin and forwards the selected target handshake', async (t) => {
  const { startDevToolsRelay } = await import('../src/devtoolsRelay.js');
  let upstreamHandshake = '';
  const upstream = net.createServer((socket) => {
    socket.once('data', (data) => {
      upstreamHandshake = data.toString('latin1');
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        '',
        '',
      ].join('\r\n'));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const relay = await startDevToolsRelay({
    upstreamPort,
    targetWebSocketUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
    token: 'relay-secret',
    idleTimeoutMs: 1_000,
  });
  t.after(() => relay.close());

  const client = net.createConnection({ host: '127.0.0.1', port: relay.port });
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write([
    'GET /devtools/page/ABC?relayToken=relay-secret HTTP/1.1',
    `Host: 127.0.0.1:${relay.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGVzdC1rZXk=',
    'Sec-WebSocket-Version: 13',
    'Origin: devtools://devtools',
    '',
    '',
  ].join('\r\n'));

  const [response] = await once(client, 'data');
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(upstreamHandshake, /^GET \/devtools\/page\/ABC HTTP\/1\.1/);
  assert.doesNotMatch(upstreamHandshake, /^Origin:/mi);
});

test('relay rejects a wrong token without connecting to the device', async (t) => {
  const { startDevToolsRelay } = await import('../src/devtoolsRelay.js');
  let upstreamConnections = 0;
  const upstream = net.createServer(() => {
    upstreamConnections += 1;
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const relay = await startDevToolsRelay({
    upstreamPort,
    targetWebSocketUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
    token: 'relay-secret',
    idleTimeoutMs: 1_000,
  });
  t.after(() => relay.close());

  const client = net.createConnection({ host: '127.0.0.1', port: relay.port });
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write([
    'GET /devtools/page/ABC?relayToken=wrong HTTP/1.1',
    `Host: 127.0.0.1:${relay.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Origin: https://chrome-devtools-frontend.appspot.com',
    '',
    '',
  ].join('\r\n'));

  const [response] = await once(client, 'data');
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 403 Forbidden/);
  assert.equal(upstreamConnections, 0);
});
