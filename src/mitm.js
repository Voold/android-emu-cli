import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { SdkError } from './errors.js';
import { launchCommandInTerminal } from './launch.js';
import { run } from './sdk.js';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.android-emu-cli', 'mitm-config.json');

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

export function buildMitmArgs(config = {}) {
  const args = [];
  for (const script of config.scripts || []) args.push('-s', script);
  if (config.listenPort) args.push('--listen-port', String(config.listenPort));
  if (config.mode && config.mode !== 'regular') args.push('--mode', config.mode);
  if (config.sslInsecure) args.push('--ssl-insecure');
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
