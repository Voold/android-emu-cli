import { randomBytes } from 'node:crypto';
import { run } from './sdk.js';
import { SdkError } from './errors.js';
import { buildRelayRequestPath, startDevToolsRelay } from './devtoolsRelay.js';

export function parseAdbDevices(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^emulator-\d+\s+device(?:\s|$)/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

export function parseAvdName(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && line !== 'OK') || null;
}

export function parseDevToolsSockets(output) {
  const sockets = new Set();
  for (const match of output.matchAll(/@(chrome_devtools_remote|webview_devtools_remote_\d+)\b/g)) {
    sockets.add(match[1]);
  }
  return [...sockets];
}

export function parseDevToolsTargets(json) {
  let targets;
  try {
    targets = JSON.parse(json);
  } catch {
    throw new SdkError('Устройство вернуло некорректный список DevTools-вкладок.');
  }

  if (!Array.isArray(targets)) return [];
  return targets
    .filter((target) => ['page', 'webview'].includes(target.type) && target.webSocketDebuggerUrl)
    .map((target) => ({
      ...target,
      title: target.title?.trim() || target.url?.trim() || 'Без названия',
    }));
}

export function buildDevToolsUrl(port, target, token) {
  const relayTarget = `127.0.0.1:${port}${buildRelayRequestPath(target.webSocketDebuggerUrl, token)}`;
  if (target.devtoolsFrontendUrl) {
    const frontendUrl = new URL(target.devtoolsFrontendUrl);
    frontendUrl.searchParams.delete('wss');
    frontendUrl.searchParams.set('ws', relayTarget);
    return frontendUrl.toString();
  }

  return `devtools://devtools/bundled/inspector.html?ws=${relayTarget}`;
}

export function listRunningEmulators() {
  const serials = parseAdbDevices(run('adb', ['devices', '-l']));
  return serials.map((serial) => ({
    serial,
    name: parseAvdName(run('adb', ['-s', serial, 'emu', 'avd', 'name'])) || serial,
  }));
}

export async function listDeviceTargets(serial, dependencies = {}) {
  const runCommand = dependencies.runCommand ?? run;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? 2_000;
  const unixSockets = runCommand('adb', ['-s', serial, 'shell', 'cat', '/proc/net/unix']);
  const sockets = parseDevToolsSockets(unixSockets);
  const result = [];

  for (const socket of sockets) {
    const portText = runCommand('adb', ['-s', serial, 'forward', 'tcp:0', `localabstract:${socket}`]).trim();
    const port = Number(portText);
    if (!Number.isInteger(port) || port <= 0) continue;

    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const targets = parseDevToolsTargets(await response.text());
      result.push(...targets.map((target) => ({ ...target, port, socket })));
    } catch {
      // Сокет мог исчезнуть между чтением /proc/net/unix и запросом.
    }
  }

  return result;
}

export async function openDevTools(target) {
  const token = randomBytes(24).toString('hex');
  const relay = await startDevToolsRelay({
    upstreamPort: target.port,
    targetWebSocketUrl: target.webSocketDebuggerUrl,
    token,
  });

  try {
    run('open', ['-a', 'Google Chrome', buildDevToolsUrl(relay.port, target, token)]);
  } catch (error) {
    await relay.close();
    throw error;
  }

  return relay;
}
