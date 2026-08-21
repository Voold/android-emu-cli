import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SdkError } from './errors.js';
import { listRunningEmulators } from './devtools.js';
import { createTerminalWindow, readTerminalTabOutput } from './launch.js';
import { buildMitmArgs, findAvailablePort, validateScriptPaths } from './mitm.js';
import { assertSdkAvailable, run } from './sdk.js';
import { loadCertificateRegistry } from './certificates.js';
import { provisionRootCertificates } from './rootProvisioning.js';
import { prepareMagiskModule } from './magisk.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortReady(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

export async function waitForPort({ host = '127.0.0.1', port, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS }, dependencies = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || timeoutMs < 0 || intervalMs <= 0) {
    throw new SdkError('Некорректные параметры ожидания порта mitmproxy.');
  }

  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const probe = dependencies.isPortReady ?? isPortReady;
  const deadline = now() + timeoutMs;

  while (true) {
    if (await probe(host, port)) return;
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new SdkError(`Таймаут ожидания mitmproxy на ${host}:${port}.`);
    }
    await wait(Math.min(intervalMs, remaining));
  }
}

function createPidMarkerPath() {
  return path.join(
    os.tmpdir(),
    `android-emu-mitm-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`
  );
}

function readPidMarker(markerPath) {
  try {
    const value = fs.readFileSync(markerPath, 'utf8').trim();
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      throw new SdkError(`Некорректный PID в marker-файле mitmproxy: ${markerPath}.`);
    }
    return Number(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SdkError) throw error;
    throw new SdkError(`Не удалось прочитать marker-файл mitmproxy: ${error.message}`);
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function doesPidOwnPort(pid, port) {
  const result = spawnSync(
    'lsof',
    ['-nP', '-a', '-p', String(pid), '-iTCP:' + port, '-sTCP:LISTEN', '-t'],
    { encoding: 'utf8' }
  );
  if (result.error) {
    throw new SdkError(`Не удалось проверить listener mitmproxy через lsof: ${result.error.message}`);
  }
  if (result.status !== 0) return false;
  return (result.stdout || '').split(/\s+/).some((value) => Number(value) === pid);
}

function removePidMarker(markerPath) {
  try {
    fs.rmSync(markerPath, { force: true });
  } catch (error) {
    throw new SdkError(`Не удалось удалить marker-файл mitmproxy: ${error.message}`);
  }
}

async function readFailureOutput(windowId, tty, readOutput) {
  try {
    const output = await readOutput(windowId, tty);
    return output || '(вывод вкладки пуст)';
  } catch (error) {
    return `не удалось прочитать вывод вкладки: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function waitForOwnedPort({ host = '127.0.0.1', port, markerPath, windowId, tty, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS }, dependencies = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !markerPath || !Number.isInteger(windowId) || !String(tty || '').trim() || timeoutMs < 0 || intervalMs <= 0) {
    throw new SdkError('Некорректные параметры ожидания процесса mitmproxy.');
  }

  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const getPid = dependencies.readPidMarker ?? readPidMarker;
  const alive = dependencies.isProcessAlive ?? isProcessAlive;
  const ownsPort = dependencies.doesPidOwnPort ?? doesPidOwnPort;
  const readOutput = dependencies.readTerminalTabOutput ?? readTerminalTabOutput;
  const deadline = now() + timeoutMs;

  while (true) {
    const pid = await getPid(markerPath);
    if (pid !== null) {
      if (!await alive(pid)) {
        const output = await readFailureOutput(windowId, tty, readOutput);
        throw new SdkError(`Процесс mitmproxy (PID ${pid}) завершился до готовности. Вывод Terminal:\n${output}`);
      }
      if (await ownsPort(pid, port, host)) return pid;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new SdkError(`Таймаут ожидания процесса mitmproxy на ${host}:${port}.`);
    }
    await wait(Math.min(intervalMs, remaining));
  }
}

function validateStackConfig({ avdName, mitmConfig = {}, capability = 'unknown', existingMitm }) {
  if (!String(avdName || '').trim()) throw new SdkError('Не указано имя AVD для запуска.');
  if (!['root-capable', 'magisk-required', 'unknown'].includes(capability)) {
    throw new SdkError(`Неизвестная capability образа: ${capability}.`);
  }
  if (existingMitm && (
    !Number.isInteger(existingMitm.pid) || existingMitm.pid <= 0
    || !Number.isInteger(existingMitm.port) || existingMitm.port < 1 || existingMitm.port > 65535
  )) {
    throw new SdkError('Некорректные данные запущенного процесса mitmproxy.');
  }
  if (mitmConfig.listenPort !== undefined && (!Number.isInteger(mitmConfig.listenPort) || mitmConfig.listenPort < 1 || mitmConfig.listenPort > 65535)) {
    throw new SdkError('Некорректный порт mitmproxy.');
  }
  if (!existingMitm) buildMitmArgs(mitmConfig);
}

function validateStackTools() {
  assertSdkAvailable();
  run('which', ['mitmproxy']);
}

async function waitUntil(readValue, { timeoutMs, intervalMs, description }, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const deadline = now() + timeoutMs;
  while (true) {
    const value = await readValue();
    if (value) return value;
    const remaining = deadline - now();
    if (remaining <= 0) throw new SdkError(`Таймаут ожидания ${description}.`);
    await wait(Math.min(intervalMs, remaining));
  }
}

async function discoverSelectedSerial(avdName, options) {
  return waitUntil(
    () => listRunningEmulators().find((device) => device.name === avdName)?.serial,
    { timeoutMs: options.serialTimeoutMs ?? DEFAULT_TIMEOUT_MS, intervalMs: options.pollIntervalMs ?? DEFAULT_INTERVAL_MS, description: `эмулятора "${avdName}"` }
  );
}

async function waitForBoot(serial, options) {
  await waitUntil(
    () => run('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).trim() === '1',
    { timeoutMs: options.bootTimeoutMs ?? DEFAULT_TIMEOUT_MS, intervalMs: options.pollIntervalMs ?? DEFAULT_INTERVAL_MS, description: `загрузки ${serial}` }
  );
}

function stageError(stage, error) {
  const original = error instanceof Error ? error : new Error(String(error));
  const wrapped = new SdkError(`Этап "${stage}": ${original.message}`);
  wrapped.cause = original;
  return wrapped;
}

async function runStage(stage, emit, operation) {
  emit({ stage, status: 'start' });
  try {
    const value = await operation();
    emit({ stage, status: 'success' });
    return value;
  } catch (error) {
    const original = error instanceof Error ? error : new Error(String(error));
    emit({ stage, status: 'error', error: original.message });
    throw stageError(stage, original);
  }
}

export function buildEffectiveEmulatorArgs({ avdName, baseArgs = [], port, capability = 'unknown' }) {
  if (!String(avdName || '').trim()) throw new SdkError('Не указано имя AVD для запуска.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SdkError('Некорректный порт прокси для эмулятора.');

  const result = ['-avd', avdName];
  let hasNoSnapshot = false;
  for (let index = 0; index < baseArgs.length; index += 1) {
    const arg = baseArgs[index];
    if (arg === '-avd' || arg === '-http-proxy') {
      index += 1;
      continue;
    }
    if (arg === '-writable-system') continue;
    if (arg === '-no-snapshot') {
      if (capability !== 'root-capable' && !hasNoSnapshot) {
        result.push(arg);
        hasNoSnapshot = true;
      }
      continue;
    }
    result.push(arg);
  }

  result.push('-http-proxy', `http://127.0.0.1:${port}`);
  if (capability === 'root-capable') result.push('-writable-system', '-no-snapshot');
  return result;
}

export async function launchStack(options, dependencies = {}) {
  const emit = options.onStage ?? (() => {});
  const mitmConfig = options.mitmConfig ?? {};
  const existingMitm = options.existingMitm ?? null;
  const capability = options.capability ?? 'unknown';
  const host = options.proxyHost ?? '127.0.0.1';
  const validateConfig = dependencies.validateConfig ?? validateStackConfig;
  const validateScripts = dependencies.validateScripts ?? validateScriptPaths;
  const validateTools = dependencies.validateTools ?? validateStackTools;
  const getRunningEmulators = dependencies.listRunningEmulators ?? listRunningEmulators;
  const getPort = dependencies.findAvailablePort ?? findAvailablePort;
  const makeMitmArgs = dependencies.buildMitmArgs ?? buildMitmArgs;
  const createWindow = dependencies.createTerminalWindow ?? createTerminalWindow;
  const makePidMarkerPath = dependencies.createPidMarkerPath ?? createPidMarkerPath;
  const getPidMarker = dependencies.readPidMarker ?? readPidMarker;
  const checkProcessAlive = dependencies.isProcessAlive ?? isProcessAlive;
  const checkPidOwnsPort = dependencies.doesPidOwnPort ?? doesPidOwnPort;
  const getTerminalOutput = dependencies.readTerminalTabOutput ?? readTerminalTabOutput;
  const deletePidMarker = dependencies.removePidMarker ?? removePidMarker;
  const findSerial = dependencies.discoverSerial ?? discoverSelectedSerial;
  const waitBoot = dependencies.waitForBoot ?? waitForBoot;
  const loadRegistry = dependencies.loadCertificateRegistry ?? loadCertificateRegistry;
  let certificates;
  const provision = dependencies.provision ?? (async ({ serial, capability: currentCapability, certificates: validatedCertificates }) => {
    if (currentCapability === 'unknown') return { changed: false, skipped: true };
    if (currentCapability === 'magisk-required') {
      return (dependencies.prepareMagiskModule ?? prepareMagiskModule)(
        {
          serial,
          avdName: options.avdName,
          certificates: validatedCertificates,
          outputPath: options.magiskOutputPath,
          statePath: options.magiskStatePath,
        },
        {
          archive: dependencies.magiskArchive,
          run: dependencies.magiskRun,
          resolveMagiskCertificateNames: dependencies.resolveMagiskCertificateNames,
          resolveDependencies: dependencies.magiskResolveDependencies,
          getDeviceProperty: dependencies.magiskGetDeviceProperty,
        }
      );
    }
    return (dependencies.provisionRootCertificates ?? provisionRootCertificates)(
      { serial, certificates: validatedCertificates },
      {
        run: dependencies.provisionRun,
        waitForBoot: dependencies.provisionWaitForBoot,
        now: dependencies.now,
        sleep: dependencies.sleep,
        timeoutMs: options.bootTimeoutMs,
        intervalMs: options.pollIntervalMs,
        listSystemCertificateNames: dependencies.listSystemCertificateNames,
        readSystemCertificate: dependencies.readSystemCertificate,
        getAndroidCertificateHash: dependencies.getAndroidCertificateHash,
      }
    );
  });

  await runStage('validate', emit, async () => {
    validateConfig({ ...options, mitmConfig, capability });
    const running = getRunningEmulators();
    const existing = running.find((device) => device.name === options.avdName);
    if (existing) {
      throw new SdkError(
        `AVD "${options.avdName}" уже запущен${existing.serial ? ` (${existing.serial})` : ''}. Закройте существующий эмулятор перед запуском стека.`
      );
    }
    if (!existingMitm) validateScripts(mitmConfig.scripts ?? []);
    validateTools();
    certificates = await loadRegistry({ includeMitm: true });
  });

  let port;
  let terminal = null;
  if (existingMitm) {
    port = await runStage('mitm-reuse', emit, async () => {
      if (!await checkPidOwnsPort(existingMitm.pid, existingMitm.port, host)) {
        throw new SdkError(`Процесс mitm PID ${existingMitm.pid} больше не слушает порт ${existingMitm.port}.`);
      }
      return existingMitm.port;
    });
  } else {
    port = await runStage('port', emit, () => getPort(mitmConfig.listenPort ?? 8080, host));
    const mitmArgs = makeMitmArgs({ ...mitmConfig, listenPort: port });
    const markerPath = makePidMarkerPath();
    try {
      terminal = await runStage('mitm', emit, () => createWindow(
        'mitmproxy',
        mitmArgs,
        'android-emu-mitm',
        { pidMarkerPath: markerPath }
      ));
      await runStage('mitm-ready', emit, () => waitForOwnedPort({
        host,
        port,
        markerPath,
        windowId: terminal.windowId,
        tty: terminal.tty,
        timeoutMs: options.proxyTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        intervalMs: options.pollIntervalMs ?? DEFAULT_INTERVAL_MS,
      }, {
        now: dependencies.now,
        sleep: dependencies.sleep,
        readPidMarker: getPidMarker,
        isProcessAlive: checkProcessAlive,
        doesPidOwnPort: checkPidOwnsPort,
        readTerminalTabOutput: getTerminalOutput,
      }));
    } finally {
      await deletePidMarker(markerPath);
    }
  }
  const windowId = terminal?.windowId ?? null;
  await runStage('emulator', emit, () => createWindow(
    'emulator',
    buildEffectiveEmulatorArgs({
      avdName: options.avdName,
      baseArgs: options.emulatorArgs ?? [],
      port,
      capability,
    }),
    'android-emu-emulator'
  ));
  const serial = await runStage('serial', emit, () => findSerial(options.avdName, options));
  await runStage('boot', emit, () => waitBoot(serial, options));
  const provisionResult = await runStage('provision', emit, () => provision({ serial, capability, certificates, port, windowId, options }));
  emit({ stage: 'ready', status: 'success' });
  return { windowId, port, serial, capability, provision: provisionResult };
}
