import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { SdkError } from './errors.js';
import { launchCommandInTerminal } from './launch.js';
import { run } from './sdk.js';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.android-emu-cli', 'mitm-config.json');
const MITM_PROCESS_NAMES = ['mitmproxy', 'mitmdump', 'mitmweb'];

function commandError(action, result) {
  const details = (result?.stderr || result?.stdout || result?.error?.message || '').trim();
  return new SdkError(details ? `${action}: ${details}` : action);
}

export function listMitmProcesses(dependencies = {}) {
  const execute = dependencies.run ?? ((command, args) => spawnSync(command, args, { encoding: 'utf8' }));
  const uid = dependencies.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || uid < 0) {
    throw new SdkError('Не удалось определить текущего пользователя для поиска процессов mitm.');
  }

  const found = new Map();
  for (const name of MITM_PROCESS_NAMES) {
    const result = execute('pgrep', ['-U', String(uid), '-x', name]);
    if (result?.error) throw commandError(`Не удалось найти процессы ${name}`, result);
    if (result?.status === 1) continue;
    if (result?.status !== 0) throw commandError(`Не удалось найти процессы ${name}`, result);
    for (const value of String(result.stdout || '').trim().split(/\s+/)) {
      if (!/^\d+$/.test(value) || Number(value) <= 0) continue;
      const pid = Number(value);
      if (!found.has(pid)) found.set(pid, { pid, name });
    }
  }
  return [...found.values()].sort((left, right) => left.pid - right.pid);
}

function listenerPorts(pid, execute) {
  const result = execute('lsof', [
    '-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn',
  ]);
  if (result?.error) throw commandError(`Не удалось проверить порты процесса mitm PID ${pid}`, result);
  if (result?.status === 1) return [];
  if (result?.status !== 0) throw commandError(`Не удалось проверить порты процесса mitm PID ${pid}`, result);
  return [...new Set(String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^n.*:(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))]
    .sort((left, right) => left - right);
}

function proxyPorts(processInfo, ports, execute) {
  if (processInfo.name !== 'mitmweb') return ports;
  const result = execute('ps', ['-p', String(processInfo.pid), '-o', 'args=']);
  if (result?.error) throw commandError(`Не удалось проверить аргументы mitmweb PID ${processInfo.pid}`, result);
  if (result?.status === 1) return [];
  if (result?.status !== 0) throw commandError(`Не удалось проверить аргументы mitmweb PID ${processInfo.pid}`, result);
  const matches = [...String(result.stdout || '').matchAll(/(?:^|\s)(?:--listen-port(?:=|\s+)|-p\s+)(\d+)(?=\s|$)/g)];
  const explicitPort = matches.at(-1)?.[1];
  const proxyPort = explicitPort ? Number(explicitPort) : 8080;
  return ports.includes(proxyPort) ? [proxyPort] : [];
}

export function findRunningMitm(configuredPort, dependencies = {}) {
  const execute = dependencies.run ?? ((command, args) => spawnSync(command, args, { encoding: 'utf8' }));
  const listProcesses = dependencies.listProcesses ?? listMitmProcesses;
  const candidates = [];
  for (const processInfo of listProcesses(dependencies)) {
    const ports = proxyPorts(processInfo, listenerPorts(processInfo.pid, execute), execute);
    for (const port of ports) {
      candidates.push({ ...processInfo, port });
    }
  }
  candidates.sort((left, right) => {
    const leftPreferred = left.port === configuredPort ? 0 : 1;
    const rightPreferred = right.port === configuredPort ? 0 : 1;
    return leftPreferred - rightPreferred || left.port - right.port || left.pid - right.pid;
  });
  return candidates[0] ?? null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopAllMitmProcesses(dependencies = {}) {
  const listProcesses = dependencies.listProcesses ?? listMitmProcesses;
  const killProcess = dependencies.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = dependencies.sleep ?? wait;
  const initial = listProcesses(dependencies);
  if (initial.length === 0) return { found: 0, terminated: 0, forced: 0 };

  const initialPids = new Set(initial.map(({ pid }) => pid));
  const signalErrors = new Map();
  for (const { pid } of initial) {
    try {
      killProcess(pid, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        signalErrors.set(pid, error);
      }
    }
  }

  await sleep(dependencies.graceMs ?? 1_000);
  const survivors = listProcesses(dependencies).filter(({ pid }) => initialPids.has(pid));
  for (const { pid } of survivors) {
    try {
      killProcess(pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        signalErrors.set(pid, error);
      }
    }
  }

  if (survivors.length > 0) await sleep(dependencies.forceWaitMs ?? 250);
  const remaining = listProcesses(dependencies).filter(({ pid }) => initialPids.has(pid));
  if (remaining.length > 0) {
    const details = remaining.map(({ pid }) => {
      const error = signalErrors.get(pid);
      return error ? `${pid} (${error.message})` : String(pid);
    }).join(', ');
    throw new SdkError(`Не удалось завершить процессы mitm PID: ${details}.`);
  }
  return { found: initial.length, terminated: initial.length, forced: survivors.length };
}

export function parseCliArgs(input = '') {
  const args = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (quote) throw new SdkError('Незакрытая кавычка в произвольных аргументах.');
  if (escaped) current += '\\';
  if (current) args.push(current);
  return args;
}

export function isSslInsecureEnabled(config = {}) {
  return config.sslInsecure !== false;
}

export function buildMitmArgs(config = {}) {
  const args = [];
  for (const script of config.scripts || []) args.push('-s', script);
  if (config.listenPort) args.push('--listen-port', String(config.listenPort));
  if (config.mode && config.mode !== 'regular') args.push('--mode', config.mode);
  if (isSslInsecureEnabled(config)) args.push('--ssl-insecure');
  if (config.blockGlobal === false) args.push('--set', 'block_global=false');
  if (config.verbosity > 0) args.push(`-${'v'.repeat(config.verbosity)}`);
  const customArgs = parseCliArgs(config.customArgs);
  for (const arg of customArgs) {
    if (arg === '--listen-port' || arg === '-p' || arg.startsWith('--listen-port=')) {
      throw new SdkError('Произвольные аргументы не могут переопределять порт mitmproxy. Настройте порт через конфигурацию.');
    }
  }
  args.push(...customArgs);
  return args;
}

export function validateScriptPaths(scripts = []) {
  for (const script of scripts) {
    if (!fs.existsSync(script) || !fs.statSync(script).isFile()) {
      throw new SdkError(`Скрипт не найден: ${script}`);
    }
  }
}

export function launchMitm(config) {
  validateScriptPaths(config.scripts);
  run('which', ['mitmproxy']);
  launchCommandInTerminal('mitmproxy', buildMitmArgs(config), 'android-emu-mitm');
}

export function isPortAvailable(port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
      else reject(err);
    });
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export async function findAvailablePort(startPort, host = '0.0.0.0') {
  for (let port = startPort; port <= 65535; port++) {
    if (await isPortAvailable(port, host)) return port;
  }
  throw new SdkError(`Не найден свободный порт, начиная с ${startPort}.`);
}

export function readMitmConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new SdkError(`Не удалось прочитать настройки mitmproxy: ${err.message}`);
  }
}

export function writeMitmConfig(config, configPath = DEFAULT_CONFIG_PATH) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (err) {
    throw new SdkError(`Не удалось сохранить настройки mitmproxy: ${err.message}`);
  }
}

export function resetMitmConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    fs.rmSync(configPath, { force: true });
  } catch (err) {
    throw new SdkError(`Не удалось сбросить настройки mitmproxy: ${err.message}`);
  }
}
