import net from 'node:net';

const MAX_HANDSHAKE_BYTES = 64 * 1024;

export function buildRelayRequestPath(targetWebSocketUrl, token) {
  const targetUrl = new URL(targetWebSocketUrl);
  targetUrl.searchParams.set('relayToken', token);
  return `${targetUrl.pathname}${targetUrl.search}`;
}

function targetRequestPath(targetWebSocketUrl) {
  const targetUrl = new URL(targetWebSocketUrl);
  return `${targetUrl.pathname}${targetUrl.search}`;
}

function writeHttpError(socket, status) {
  socket.end([
    `HTTP/1.1 ${status}`,
    'Connection: close',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n'));
}

function rewriteHandshake(handshake, relayPath, upstreamPath) {
  const text = handshake.toString('latin1');
  const lines = text.split('\r\n');
  const [method, requestPath, protocol] = lines[0]?.split(' ') ?? [];
  const headers = lines.slice(1).filter(Boolean);
  const upgrade = headers.find((line) => /^upgrade:/i.test(line));
  const connection = headers.find((line) => /^connection:/i.test(line));

  if (
    method !== 'GET'
    || requestPath !== relayPath
    || protocol !== 'HTTP/1.1'
    || !/^upgrade:\s*websocket\s*$/i.test(upgrade ?? '')
    || !/^connection:.*\bupgrade\b/i.test(connection ?? '')
  ) {
    return null;
  }

  const forwardedHeaders = headers.filter((line) => !/^origin:/i.test(line));
  return Buffer.from([
    `GET ${upstreamPath} HTTP/1.1`,
    ...forwardedHeaders,
    '',
    '',
  ].join('\r\n'), 'latin1');
}

export async function startDevToolsRelay({
  upstreamPort,
  targetWebSocketUrl,
  token,
  idleTimeoutMs = 5 * 60 * 1000,
}) {
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
    throw new TypeError('upstreamPort должен быть положительным целым числом.');
  }
  if (!token) throw new TypeError('Для DevTools relay нужен непустой token.');

  const relayPath = buildRelayRequestPath(targetWebSocketUrl, token);
  const upstreamPath = targetRequestPath(targetWebSocketUrl);
  const server = net.createServer();
  const sockets = new Set();
  let activeSessions = 0;
  let idleTimer;

  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => server.close(), idleTimeoutMs);
    idleTimer.unref?.();
  };

  server.on('connection', (client) => {
    sockets.add(client);
    client.unref?.();
    client.on('error', () => {});
    let pending = Buffer.alloc(0);
    let upstream = null;
    let sessionStarted = false;

    const finishSession = () => {
      sockets.delete(client);
      if (upstream) {
        sockets.delete(upstream);
        upstream.destroy();
      }
      if (sessionStarted) {
        sessionStarted = false;
        activeSessions -= 1;
        if (activeSessions === 0) armIdleTimer();
      }
    };

    client.once('close', finishSession);
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_HANDSHAKE_BYTES) {
        client.removeListener('data', onData);
        writeHttpError(client, '431 Request Header Fields Too Large');
        return;
      }

      const headerEnd = pending.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      client.removeListener('data', onData);
      const handshakeEnd = headerEnd + 4;
      const rewritten = rewriteHandshake(pending.subarray(0, handshakeEnd), relayPath, upstreamPath);
      if (!rewritten) {
        writeHttpError(client, '403 Forbidden');
        return;
      }

      clearTimeout(idleTimer);
      sessionStarted = true;
      activeSessions += 1;
      client.pause();
      upstream = net.createConnection({ host: '127.0.0.1', port: upstreamPort });
      sockets.add(upstream);
      upstream.unref?.();
      upstream.once('connect', () => {
        upstream.write(rewritten);
        const trailing = pending.subarray(handshakeEnd);
        if (trailing.length > 0) upstream.write(trailing);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.once('error', () => {
        if (!client.destroyed) writeHttpError(client, '502 Bad Gateway');
      });
      upstream.once('close', () => client.destroy());
    };

    client.on('data', onData);
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  server.unref?.();
  armIdleTimer();

  return {
    port: server.address().port,
    close() {
      clearTimeout(idleTimer);
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(resolve);
      });
    },
  };
}
