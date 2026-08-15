import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SdkError } from './errors.js';
import { androidCertificateName } from './certificates.js';
import { run as runSdk } from './sdk.js';
import { determineActiveCertificateStore } from './magisk.js';

const SYSTEM_CERTIFICATE_DIRECTORY = '/system/etc/security/cacerts';
const APEX_CERTIFICATE_DIRECTORY = '/apex/com.android.conscrypt/cacerts';
const APEX_MERGED_DIRECTORY = '/data/local/tmp/android-emu-apex-cacerts';
const ANDROID_CERTIFICATE_NAME = /^([a-f0-9]{8})\.(\d+)$/i;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 500;
const AVBCTL_UNSUPPORTED = /(?:avbctl.*(?:not found|not supported|unsupported|unknown command|not implemented)|(?:not found|not supported|unsupported|unknown command|not implemented).*avbctl)/i;

function assertSerial(serial) {
  if (!String(serial || '').trim()) throw new SdkError('Не указан serial эмулятора для установки сертификатов.');
}

function assertCertificates(certificates) {
  if (!Array.isArray(certificates) || certificates.length === 0) throw new SdkError('Не переданы публичные сертификаты для установки.');
  for (const certificate of certificates) {
    if (!certificate || !String(certificate.id || '').trim() || !String(certificate.path || '').trim() || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i.test(certificate.fingerprint || '')) {
      throw new SdkError('Некорректный публичный сертификат для Android provisioning.');
    }
  }
}

function targetPath(certificate) {
  return `${SYSTEM_CERTIFICATE_DIRECTORY}/${certificate.androidName}`;
}

function apexTargetPath(certificate) {
  return `${APEX_MERGED_DIRECTORY}/${certificate.androidName}`;
}

function adbArgs(serial, args) {
  return ['-s', serial, ...args];
}

function command(stage, args) {
  return Object.freeze({ stage, kind: 'command', argv: ['adb', ...args] });
}

function wait(stage) {
  return Object.freeze({ stage, kind: 'wait' });
}

function rootSteps(serial, stage) {
  return [
    command(stage, adbArgs(serial, ['root'])),
    wait(`wait-after-${stage}`),
  ];
}

function rebootSteps(serial, stage) {
  return [
    command(stage, adbArgs(serial, ['reboot'])),
    wait(stage.replace('reboot', 'wait')),
  ];
}

export function buildRootProvisioningPlan({ serial, certificates, deviceState = {} }) {
  assertSerial(serial);
  assertCertificates(certificates);
  const certificatesToInstall = deviceState.certificatesToInstall ?? certificates;
  if (!Array.isArray(certificatesToInstall) || certificatesToInstall.some((certificate) => !certificates.includes(certificate))) {
    throw new SdkError('Некорректное состояние системного хранилища сертификатов Android.');
  }
  if (certificatesToInstall.length === 0) return [Object.freeze({ stage: 'verify-final', kind: 'verify' })];
  for (const certificate of certificatesToInstall) {
    if (!ANDROID_CERTIFICATE_NAME.test(certificate.androidName || '')) throw new SdkError('Для плана provisioning не задано корректное имя Android-сертификата.');
  }

  const steps = [...rootSteps(serial, 'adb-root')];
  if (deviceState.verificationDisabled !== true && deviceState.verificationUnsupported !== true) {
    steps.push(command('disable-verification', adbArgs(serial, ['shell', 'avbctl', 'disable-verification'])));
    if (deviceState.verificationRequiresReboot === true) {
      steps.push(...rebootSteps(serial, 'reboot-after-verification'));
      steps.push(...rootSteps(serial, 'adb-root-after-verification-reboot'));
    }
  }
  steps.push(command('remount', adbArgs(serial, ['remount'])));
  if (deviceState.remountRequiresReboot === true) {
    steps.push(...rebootSteps(serial, 'reboot-after-remount'));
    steps.push(...rootSteps(serial, 'adb-root-after-remount-reboot'));
    steps.push(command('remount-after-reboot', adbArgs(serial, ['remount'])));
  }
  for (const certificate of certificatesToInstall) {
    steps.push(command(`install:${certificate.id}`, adbArgs(serial, ['push', certificate.path, targetPath(certificate)])));
    steps.push(command(`chmod:${certificate.id}`, adbArgs(serial, ['shell', 'chmod', '0644', targetPath(certificate)])));
  }
  steps.push(...rebootSteps(serial, 'reboot-after-install'));
  steps.push(Object.freeze({ stage: 'verify-final', kind: 'verify' }));
  return steps;
}

export function parseVerificationResult(output) {
  const original = String(output || '').trim();
  const text = original.toLowerCase();
  if (AVBCTL_UNSUPPORTED.test(original)) return { requiresReboot: false, unsupported: true, warning: original };
  if (/already (disabled|off)|already disabled/.test(text)) return { requiresReboot: false };
  if (/(disabled verification|verification disabled|successfully disabled)/.test(text) && /reboot/.test(text)) return { requiresReboot: true };
  throw new SdkError(`Не удалось определить результат avbctl disable-verification: ${original || '(пустой вывод)'}.`);
}

export function parseRemountResult(output) {
  const text = String(output || '').trim().toLowerCase();
  if (/\bfail(?:ed|ure)\b|not running as root/.test(text)) {
    throw new SdkError(`Не удалось выполнить adb remount: ${String(output || '').trim() || '(пустой вывод)'}.`);
  }
  const rebootForSettings = /(?:now\s+reboot(?:\s+(?:your\s+)?device)?(?:\s+for\s+(?:settings|[^\n]*refresh)|\s+to\s+take\s+effect)?|reboot\s+(?:required|for\s+(?:settings|[^\n]*refresh)|to\s+take\s+effect))/.test(text);
  const overlayfsRebootSuccess = /verity disabled/.test(text) && /overlayfs enabled/.test(text) && rebootForSettings;
  const overlayfsMountRebootSuccess = /using overlayfs for\s+\/[^\s]+/.test(text) && rebootForSettings;
  if (!/remount succeeded|remounted/.test(text) && !overlayfsRebootSuccess && !overlayfsMountRebootSuccess) {
    throw new SdkError(`Не удалось определить результат adb remount: ${String(output || '').trim() || '(пустой вывод)'}.`);
  }
  return { requiresReboot: rebootForSettings };
}

function defaultRun(bin, args) {
  return runSdk(bin, args);
}

function defaultReadSystemCertificate({ serial, path }) {
  const result = spawnSync('adb', adbArgs(serial, ['exec-out', 'cat', path]), { encoding: null });
  if (result.error) throw new SdkError(`Не удалось прочитать системный сертификат ${path}: ${result.error.message}`);
  if (result.status === 0) return result.stdout;
  const details = Buffer.from(result.stderr || '').toString('utf8').trim();
  if (/no such file|not found/i.test(details)) return null;
  throw new SdkError(`Не удалось прочитать системный сертификат ${path}: ${details || `adb завершился с кодом ${result.status}`}.`);
}

function defaultAndroidCertificateHash(certificate) {
  return androidCertificateName(certificate.path, 0).slice(0, -2);
}

export function parseAndroidCertificateNames(output) {
  return [...new Set(String(output || '').split(/\s+/).filter((name) => ANDROID_CERTIFICATE_NAME.test(name)).map((name) => name.toLowerCase()))]
    .sort((left, right) => {
      const [, leftHash, leftIndex] = left.match(ANDROID_CERTIFICATE_NAME);
      const [, rightHash, rightIndex] = right.match(ANDROID_CERTIFICATE_NAME);
      return leftHash.localeCompare(rightHash) || Number(leftIndex) - Number(rightIndex);
    });
}

/** Проверяет, что stat вывел ровно пару device:inode для source и target одного bind-mount. */
export function parseApexMountIdentity(output) {
  const values = String(output ?? '').trim().split(/\s+/);
  return values.length === 2
    && values.every((value) => /^\d+:\d+$/.test(value))
    && values[0] === values[1];
}

async function defaultListSystemCertificateNames({ serial }) {
  return parseAndroidCertificateNames(await defaultRun('adb', adbArgs(serial, ['shell', 'ls', '-1', SYSTEM_CERTIFICATE_DIRECTORY])));
}

async function defaultListApexCertificateNames({ serial }) {
  try {
    return parseAndroidCertificateNames(await defaultRun('adb', adbArgs(serial, ['shell', 'ls', '-1', APEX_CERTIFICATE_DIRECTORY])));
  } catch (error) {
    if (/no such file|not found/i.test(error.message)) return [];
    throw error;
  }
}

async function defaultGetDeviceProperty({ serial, key }) {
  return defaultRun('adb', adbArgs(serial, ['shell', 'getprop', key]));
}

export function fingerprintCertificateBytes(content, certificatePath = 'системный сертификат') {
  if (content === null || content === undefined || (Buffer.isBuffer(content) && content.length === 0)) return null;
  try {
    return new X509Certificate(content).fingerprint256.toUpperCase();
  } catch (error) {
    throw new SdkError(`Не удалось разобрать X.509 ${certificatePath}: ${error.message}`);
  }
}

function normalizeAndroidHash(value, certificate) {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(hash)) throw new SdkError(`Некорректный subject_hash_old для ${certificate.id}: ${hash || '(пусто)'}.`);
  return hash;
}

export async function resolveDeviceCertificateNames({ serial, certificates }, dependencies = {}) {
  assertSerial(serial);
  assertCertificates(certificates);
  const listNames = dependencies.listSystemCertificateNames ?? defaultListSystemCertificateNames;
  const readCertificate = dependencies.readSystemCertificate ?? defaultReadSystemCertificate;
  const getHash = dependencies.getAndroidCertificateHash ?? defaultAndroidCertificateHash;
  let listed;
  try {
    listed = await listNames({ serial });
  } catch (error) {
    throw new SdkError(`Не удалось получить список системных сертификатов Android: ${error instanceof Error ? error.message : String(error)}`);
  }
  const occupied = new Set(Array.isArray(listed) ? listed.filter((name) => ANDROID_CERTIFICATE_NAME.test(name)).map((name) => name.toLowerCase()) : parseAndroidCertificateNames(listed));
  const resolved = [];

  for (const certificate of certificates) {
    const hash = normalizeAndroidHash(await getHash(certificate), certificate);
    const candidates = [...occupied].filter((name) => name.startsWith(`${hash}.`)).sort((left, right) => Number(left.split('.')[1]) - Number(right.split('.')[1]));
    let exactName = null;
    for (const name of candidates) {
      const candidatePath = `${SYSTEM_CERTIFICATE_DIRECTORY}/${name}`;
      const content = await readCertificate({ serial, certificate, path: candidatePath });
      if (fingerprintCertificateBytes(content, candidatePath) === certificate.fingerprint.toUpperCase()) {
        exactName = name;
        break;
      }
    }
    if (exactName) {
      resolved.push(Object.freeze({ ...certificate, androidName: exactName, needsInstall: false }));
      continue;
    }
    let collisionIndex = 0;
    while (occupied.has(`${hash}.${collisionIndex}`)) collisionIndex += 1;
    const androidName = `${hash}.${collisionIndex}`;
    occupied.add(androidName);
    resolved.push(Object.freeze({ ...certificate, androidName, needsInstall: true }));
  }
  return resolved;
}

async function inspectCertificates({ serial, certificates, readSystemCertificate }) {
  const missing = [];
  for (const certificate of certificates) {
    const path = targetPath(certificate);
    const content = await readSystemCertificate({ serial, certificate, path });
    if (fingerprintCertificateBytes(content, path) !== certificate.fingerprint.toUpperCase()) missing.push(certificate);
  }
  return missing;
}

async function runStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    const wrapped = new SdkError(`Этап "${stage}": ${details}\nПовторите запуск после устранения причины; сертификаты не будут подменены молча.`);
    wrapped.cause = error;
    throw wrapped;
  }
}

export async function waitForDeviceBoot(serial, dependencies = {}) {
  assertSerial(serial);
  const run = dependencies.run ?? defaultRun;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = dependencies.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new SdkError('Некорректные параметры ожидания загрузки Android.');
  await run('adb', adbArgs(serial, ['wait-for-device']));
  const deadline = now() + timeoutMs;
  while (true) {
    if (String(await run('adb', adbArgs(serial, ['shell', 'getprop', 'sys.boot_completed']))).trim() === '1') return;
    const remaining = deadline - now();
    if (remaining <= 0) throw new SdkError(`Таймаут ожидания загрузки Android ${serial}.`);
    await sleep(Math.min(intervalMs, remaining));
  }
}

function isUnsupportedAvbError(error) {
  return AVBCTL_UNSUPPORTED.test(error instanceof Error ? error.message : String(error));
}

async function resolveApexCertificateNames({ serial, certificates, systemNames, apexNames }, dependencies) {
  const readStoreCertificate = dependencies.readStoreCertificate ?? (async ({ path }) => defaultReadSystemCertificate({ serial, path }));
  const getHash = dependencies.getAndroidCertificateHash ?? defaultAndroidCertificateHash;
  const occupied = new Set([...systemNames, ...apexNames]);
  const active = new Set(apexNames);
  const resolved = [];
  for (const certificate of certificates) {
    const hash = normalizeAndroidHash(await getHash(certificate), certificate);
    const candidates = [...occupied].filter((name) => name.startsWith(`${hash}.`)).sort((left, right) => Number(left.split('.')[1]) - Number(right.split('.')[1]));
    let activeName = null;
    for (const name of candidates) {
      if (!active.has(name)) continue;
      const content = await readStoreCertificate({ serial, directory: APEX_CERTIFICATE_DIRECTORY, name, path: `${APEX_CERTIFICATE_DIRECTORY}/${name}` });
      if (fingerprintCertificateBytes(content, `${APEX_CERTIFICATE_DIRECTORY}/${name}`) === certificate.fingerprint.toUpperCase()) {
        activeName = name;
        break;
      }
    }
    if (activeName) {
      resolved.push(Object.freeze({ ...certificate, androidName: activeName, needsInstall: false }));
      continue;
    }
    let suffix = 0;
    while (occupied.has(`${hash}.${suffix}`)) suffix += 1;
    const androidName = `${hash}.${suffix}`;
    occupied.add(androidName);
    resolved.push(Object.freeze({ ...certificate, androidName, needsInstall: true }));
  }
  return resolved;
}

async function defaultPrepareApexMergedStore({ serial, run }) {
  await run('adb', adbArgs(serial, ['shell', 'rm', '-rf', APEX_MERGED_DIRECTORY]));
  await run('adb', adbArgs(serial, ['shell', 'mkdir', '-p', APEX_MERGED_DIRECTORY]));
  await run('adb', adbArgs(serial, ['shell', 'sh', '-c', `cp -fp ${APEX_CERTIFICATE_DIRECTORY}/* ${APEX_MERGED_DIRECTORY}/`]));
}

async function defaultPushApexCertificate({ serial, certificate, run }) {
  await run('adb', adbArgs(serial, ['push', certificate.path, apexTargetPath(certificate)]));
}

async function defaultFinalizeApexMergedStore({ serial, run }) {
  await run('adb', adbArgs(serial, ['shell', 'chown', '0:0', APEX_MERGED_DIRECTORY]));
  await run('adb', adbArgs(serial, ['shell', 'chmod', '0755', APEX_MERGED_DIRECTORY]));
  await run('adb', adbArgs(serial, ['shell', 'sh', '-c', `chown 0:0 ${APEX_MERGED_DIRECTORY}/* && chmod 0644 ${APEX_MERGED_DIRECTORY}/* && chcon u:object_r:system_file:s0 ${APEX_MERGED_DIRECTORY} ${APEX_MERGED_DIRECTORY}/*`]));
}

async function defaultBindApexStore({ serial, run }) {
  await run('adb', adbArgs(serial, ['shell', 'mount', '-o', 'bind', APEX_MERGED_DIRECTORY, APEX_CERTIFICATE_DIRECTORY]));
}

async function defaultFindZygotePids({ serial, run }) {
  const values = await Promise.all(['zygote', 'zygote64'].map(async (name) => {
    try { return await run('adb', adbArgs(serial, ['shell', 'pidof', name])); } catch { return ''; }
  }));
  return [...new Set(values.flatMap((value) => String(value).trim().split(/\s+/).filter((pid) => /^\d+$/.test(pid)).map(Number)))];
}

async function defaultBindApexInNamespace({ serial, pid, run }) {
  await run('adb', adbArgs(serial, ['shell', 'nsenter', '-t', String(pid), '-m', '--', 'mount', '-o', 'bind', APEX_MERGED_DIRECTORY, APEX_CERTIFICATE_DIRECTORY]));
}

async function defaultVerifyApexMount({ serial, pid, run }) {
  const args = pid === null
    ? ['shell', 'stat', '-c', '%d:%i', APEX_MERGED_DIRECTORY, APEX_CERTIFICATE_DIRECTORY]
    : ['shell', 'nsenter', '-t', String(pid), '-m', '--', 'stat', '-c', '%d:%i', APEX_MERGED_DIRECTORY, APEX_CERTIFICATE_DIRECTORY];
  const output = await run('adb', adbArgs(serial, args));
  return parseApexMountIdentity(output);
}

async function provisionApexCertificates({ serial, certificates, systemNames, apexNames }, dependencies) {
  const resolved = await resolveApexCertificateNames({ serial, certificates, systemNames, apexNames }, dependencies);
  const missing = resolved.filter((certificate) => certificate.needsInstall);
  if (missing.length === 0) return { changed: false, installed: [], store: 'apex' };
  const prepare = dependencies.prepareApexMergedStore ?? defaultPrepareApexMergedStore;
  const push = dependencies.pushApexCertificate ?? defaultPushApexCertificate;
  const finalize = dependencies.finalizeApexMergedStore ?? defaultFinalizeApexMergedStore;
  const bindHost = dependencies.bindApexStore ?? defaultBindApexStore;
  const findZygotes = dependencies.findZygotePids ?? defaultFindZygotePids;
  const bindZygote = dependencies.bindApexInNamespace ?? defaultBindApexInNamespace;
  const verifyMount = dependencies.verifyApexMount ?? defaultVerifyApexMount;
  const verifyCertificate = dependencies.verifyActiveCertificate ?? (async ({ certificate }) => {
    const content = await (dependencies.readStoreCertificate ?? (async ({ path }) => defaultReadSystemCertificate({ serial, path })))({
      serial, certificate, path: `${APEX_CERTIFICATE_DIRECTORY}/${certificate.androidName}`,
    });
    return fingerprintCertificateBytes(content, certificate.id) === certificate.fingerprint.toUpperCase();
  });
  const run = dependencies.run ?? defaultRun;
  const waitForBoot = dependencies.waitForBoot ?? ((candidateSerial) => waitForDeviceBoot(candidateSerial, { run, now: dependencies.now, sleep: dependencies.sleep, timeoutMs: dependencies.timeoutMs, intervalMs: dependencies.intervalMs }));
  await run('adb', adbArgs(serial, ['root']));
  await waitForBoot(serial);
  await prepare({ serial, certificates: resolved, apexNames, run });
  for (const certificate of missing) await push({ serial, certificate, run });
  await finalize({ serial, certificates: resolved, run });
  await bindHost({ serial, run });
  const attempts = dependencies.zygoteAttempts ?? 20;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let verified = false;
  let lastNamespaceError = 'zygote namespace не найден.';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const pids = await findZygotes({ serial, run });
      if (pids.length > 0) {
        for (const pid of pids) await bindZygote({ serial, pid, run });
        const mounts = await Promise.all([verifyMount({ serial, pid: null, run }), ...pids.map((pid) => verifyMount({ serial, pid, run }))]);
        if (mounts.every(Boolean)) { verified = true; break; }
        lastNamespaceError = 'Проверка device+inode не подтвердила один bind-mount в host и каждом zygote namespace.';
      } else {
        lastNamespaceError = 'zygote namespace не найден.';
      }
    } catch (error) {
      // zygote может появиться или сменить namespace во время late boot; retry bounded.
      lastNamespaceError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts - 1) await sleep(1_000);
  }
  if (!verified) throw new SdkError(`Этап "apex-namespace": не удалось подтвердить bind-mount CA в host и zygote namespace. Последняя причина: ${lastNamespaceError || '(пустой вывод)'}. Готовность не подтверждена.`);
  for (const certificate of resolved) {
    if (!await verifyCertificate({ serial, certificate })) {
      throw new SdkError(`Этап "verify-final": APEX CA ${certificate.id} не подтверждён. Готовность не подтверждена.`);
    }
  }
  return { changed: true, installed: missing.map((certificate) => certificate.id), store: 'apex' };
}

export async function provisionRootCertificates({ serial, certificates, deviceState = {} }, dependencies = {}) {
  assertSerial(serial);
  assertCertificates(certificates);
  const run = dependencies.run ?? defaultRun;
  const getProperty = dependencies.getDeviceProperty ?? (async ({ key }) => run('adb', adbArgs(serial, ['shell', 'getprop', key])));
  const listSystemNames = dependencies.listSystemCertificateNames ?? (async ({ serial: candidateSerial }) => parseAndroidCertificateNames(
    await run('adb', adbArgs(candidateSerial, ['shell', 'ls', '-1', SYSTEM_CERTIFICATE_DIRECTORY]))
  ));
  const listApexNames = dependencies.listApexCertificateNames ?? (async ({ serial: candidateSerial }) => {
    try {
      return parseAndroidCertificateNames(await run('adb', adbArgs(candidateSerial, ['shell', 'ls', '-1', APEX_CERTIFICATE_DIRECTORY])));
    } catch (error) {
      if (/no such file|not found/i.test(error.message)) return [];
      throw error;
    }
  });
  const sdkVersion = await runStage('active-store', () => getProperty({ serial, key: 'ro.build.version.sdk' }));
  const systemCertsEnabled = await runStage('active-store', () => getProperty({ serial, key: 'system.certs.enabled' }));
  const needsApexProbe = Number(String(sdkVersion).trim()) >= 34 && String(systemCertsEnabled).trim() !== 'true';
  const apexNames = needsApexProbe ? await runStage('active-store', () => listApexNames({ serial })) : [];
  const activeStore = await runStage('active-store', () => determineActiveCertificateStore({ sdkVersion, systemCertsEnabled, apexNames }));
  if (activeStore === 'apex') {
    const systemNames = await runStage('active-store', () => listSystemNames({ serial }));
    return runStage('apex-provision', () => provisionApexCertificates({ serial, certificates, systemNames, apexNames }, dependencies));
  }
  const readSystemCertificate = dependencies.readSystemCertificate ?? defaultReadSystemCertificate;
  const waitForBoot = dependencies.waitForBoot ?? ((candidateSerial) => waitForDeviceBoot(candidateSerial, {
    run,
    now: dependencies.now,
    sleep: dependencies.sleep,
    timeoutMs: dependencies.timeoutMs,
    intervalMs: dependencies.intervalMs,
  }));
  const execute = (stage, args) => runStage(stage, () => run('adb', args));
  const waitAfter = (stage) => runStage(stage, () => waitForBoot(serial));
  const acquireRoot = async (stage) => {
    await execute(stage, adbArgs(serial, ['root']));
    await waitAfter(`wait-after-${stage}`);
  };
  const rebootAndReacquireRoot = async (stage, rootStage) => {
    await execute(stage, adbArgs(serial, ['reboot']));
    await waitAfter(stage.replace('reboot', 'wait'));
    await acquireRoot(rootStage);
  };
  const resolved = await runStage('resolve-names', () => resolveDeviceCertificateNames({ serial, certificates }, {
    listSystemCertificateNames: dependencies.listSystemCertificateNames ?? (async ({ serial: candidateSerial }) => parseAndroidCertificateNames(
      await run('adb', adbArgs(candidateSerial, ['shell', 'ls', '-1', SYSTEM_CERTIFICATE_DIRECTORY]))
    )),
    readSystemCertificate,
    getAndroidCertificateHash: dependencies.getAndroidCertificateHash,
  }));
  const missing = await runStage('compare', () => inspectCertificates({ serial, certificates: resolved, readSystemCertificate }));
  if (missing.length === 0) return { changed: false, installed: [] };

  const warnings = [];
  await acquireRoot('adb-root');
  if (deviceState.verificationDisabled !== true) {
    let verification;
    try {
      verification = await run('adb', adbArgs(serial, ['shell', 'avbctl', 'disable-verification']));
      verification = parseVerificationResult(verification);
    } catch (error) {
      if (isUnsupportedAvbError(error)) {
        verification = { requiresReboot: false, unsupported: true, warning: error instanceof Error ? error.message : String(error) };
      } else {
        await runStage('disable-verification', () => { throw error; });
      }
    }
    if (verification.unsupported) {
      warnings.push(Object.freeze({ stage: 'disable-verification', message: `avbctl недоступен: ${verification.warning}. Продолжаю с adb remount.` }));
    } else if (verification.requiresReboot) {
      await rebootAndReacquireRoot('reboot-after-verification', 'adb-root-after-verification-reboot');
    }
  }

  let remountOutput = await execute('remount', adbArgs(serial, ['remount']));
  let remount = await runStage('remount', () => parseRemountResult(remountOutput));
  if (remount.requiresReboot) {
    await rebootAndReacquireRoot('reboot-after-remount', 'adb-root-after-remount-reboot');
    remountOutput = await execute('remount-after-reboot', adbArgs(serial, ['remount']));
    remount = await runStage('remount-after-reboot', () => parseRemountResult(remountOutput));
    if (remount.requiresReboot) throw new SdkError('Этап "remount-after-reboot": adb remount повторно требует reboot. Повторите запуск после перезагрузки эмулятора.');
  }

  for (const certificate of missing) {
    await execute(`install:${certificate.id}`, adbArgs(serial, ['push', certificate.path, targetPath(certificate)]));
    await execute(`chmod:${certificate.id}`, adbArgs(serial, ['shell', 'chmod', '0644', targetPath(certificate)]));
  }
  await execute('reboot-after-install', adbArgs(serial, ['reboot']));
  await waitAfter('wait-after-install');
  const stillMissing = await runStage('verify-final', () => inspectCertificates({ serial, certificates: resolved, readSystemCertificate }));
  if (stillMissing.length > 0) {
    throw new SdkError(`Этап "verify-final": не подтверждены отпечатки сертификатов: ${stillMissing.map((certificate) => certificate.id).join(', ')}. Повторите запуск после устранения причины; сертификаты не будут подменены молча.`);
  }
  const result = { changed: true, installed: missing.map((certificate) => certificate.id) };
  return warnings.length > 0 ? { ...result, warnings } : result;
}
