import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SdkError } from './errors.js';
import { androidCertificateName } from './certificates.js';
import { run as runSdk } from './sdk.js';

const FINGERPRINT = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;
const ANDROID_NAME = /^[a-f0-9]{8}\.[0-9]+$/i;
const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i;
const REMOTE_MODULE_PATH = '/storage/emulated/0/Download/android-emu-ca-module.zip';
const SYSTEM_CA_DIRECTORY = '/system/etc/security/cacerts';
const APEX_CA_DIRECTORY = '/apex/com.android.conscrypt/cacerts';
const ASSET_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'magisk');
const ASSET_FILES = Object.freeze(['module.prop', 'post-fs-data.sh', 'service.sh']);

function sdkError(message, cause) {
  const error = new SdkError(message);
  if (cause) error.cause = cause;
  return error;
}

function assertSerial(serial) {
  if (!String(serial || '').trim()) throw new SdkError('Не указан serial эмулятора для Magisk-модуля.');
}

function assertOutputPath(outputPath) {
  if (!path.isAbsolute(String(outputPath || '')) || path.extname(outputPath).toLowerCase() !== '.zip' || String(outputPath).includes('\0')) {
    throw new SdkError('Путь к Magisk-модулю должен быть абсолютным путём к .zip-файлу.');
  }
}

function normalizeFingerprint(value, field = 'отпечаток') {
  const normalized = String(value || '').trim().toUpperCase();
  if (!FINGERPRINT.test(normalized)) throw new SdkError(`Некорректный ${field} сертификата.`);
  return normalized;
}

function readPublicCertificate(certificate, { requireAndroidName = true } = {}) {
  if (!certificate || typeof certificate !== 'object' || !String(certificate.id || '').trim() || !String(certificate.path || '').trim()) {
    throw new SdkError('Некорректное описание публичного сертификата для Magisk-модуля.');
  }
  if (requireAndroidName && !ANDROID_NAME.test(String(certificate.androidName || ''))) {
    throw new SdkError(`Некорректное имя Android-сертификата: ${certificate.androidName || '(пусто)'}.`);
  }
  let content;
  try {
    content = fs.readFileSync(certificate.path);
  } catch (error) {
    throw sdkError(`Не удалось прочитать публичный сертификат ${certificate.path}: ${error.message}`, error);
  }
  if (PRIVATE_KEY.test(content.toString('utf8'))) {
    throw new SdkError(`В Magisk-модуль нельзя включать закрытый ключ: ${certificate.path}.`);
  }
  let actualFingerprint;
  try {
    actualFingerprint = new X509Certificate(content).fingerprint256.toUpperCase();
  } catch (error) {
    throw sdkError(`Не удалось разобрать X.509 сертификат ${certificate.path}: ${error.message}`, error);
  }
  const expectedFingerprint = normalizeFingerprint(certificate.fingerprint);
  if (actualFingerprint !== expectedFingerprint) {
    throw new SdkError(`Отпечаток публичного сертификата ${certificate.path} не совпадает с описанием.`);
  }
  return Object.freeze({ ...certificate, fingerprint: expectedFingerprint, androidName: certificate.androidName?.toLowerCase(), content });
}

function parseAndroidCertificateNames(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  return [...new Set(values.filter((name) => ANDROID_NAME.test(name)).map((name) => name.toLowerCase()))]
    .sort((left, right) => {
      const [leftHash, leftSuffix] = left.split('.');
      const [rightHash, rightSuffix] = right.split('.');
      return leftHash.localeCompare(rightHash) || Number(leftSuffix) - Number(rightSuffix);
    });
}

function normalizeSdkVersion(value) {
  const normalized = String(value ?? '').trim();
  if (!/^[0-9]{1,3}$/.test(normalized) || Number(normalized) < 1 || Number(normalized) > 999) {
    throw new SdkError(`Некорректный Android SDK level: ${normalized || '(пусто)'}.`);
  }
  return Number(normalized);
}

function normalizeSystemCertsEnabled(value) {
  const normalized = String(value ?? '').trim();
  if (!['', 'true', 'false'].includes(normalized)) {
    throw new SdkError(`Некорректное свойство system.certs.enabled: ${normalized}.`);
  }
  return normalized;
}

export function determineActiveCertificateStore({ sdkVersion, systemCertsEnabled, apexNames } = {}) {
  const sdk = normalizeSdkVersion(sdkVersion);
  const enabled = normalizeSystemCertsEnabled(systemCertsEnabled);
  if (!Array.isArray(apexNames)) throw new SdkError('Список сертификатов Conscrypt APEX должен быть массивом.');
  return sdk >= 34 && enabled !== 'true' && apexNames.length > 0 ? 'apex' : 'system';
}

function isAbsentApexDirectory(error) {
  return /(?:no such file(?: or directory)?|not found)/i.test(error instanceof Error ? error.message : String(error));
}

function defaultListCertificateNames({ serial, directory }) {
  return parseAndroidCertificateNames(runSdk('adb', ['-s', serial, 'shell', 'ls', '-1', directory]));
}

function defaultGetDeviceProperty({ serial, key }) {
  if (!['ro.build.version.sdk', 'system.certs.enabled'].includes(key)) {
    throw new SdkError(`Недопустимое Android system property: ${key}.`);
  }
  return runSdk('adb', ['-s', serial, 'shell', 'getprop', key]);
}

function defaultReadCertificate({ serial, directory, name }) {
  const certificatePath = `${directory}/${name}`;
  const result = spawnSync('adb', ['-s', serial, 'exec-out', 'cat', certificatePath], { encoding: null });
  if (result.error) throw sdkError(`Не удалось прочитать Android CA ${certificatePath}: ${result.error.message}`, result.error);
  if (result.status !== 0) {
    const details = Buffer.from(result.stderr || '').toString('utf8').trim();
    throw new SdkError(`Не удалось прочитать Android CA ${certificatePath}: ${details || `adb завершился с кодом ${result.status}`}.`);
  }
  return result.stdout;
}

function defaultAndroidCertificateHash(certificate) {
  return androidCertificateName(certificate.path, 0).slice(0, -2);
}

function fingerprintDeviceCertificate(content, certificatePath) {
  try {
    return new X509Certificate(content).fingerprint256.toUpperCase();
  } catch (error) {
    throw sdkError(`Не удалось разобрать X.509 Android CA ${certificatePath}: ${error.message}`, error);
  }
}

async function listCertificateStore({ serial, directory, allowAbsent }, listCertificateNames) {
  try {
    return parseAndroidCertificateNames(await listCertificateNames({ serial, directory }));
  } catch (error) {
    if (allowAbsent && isAbsentApexDirectory(error)) return [];
    throw sdkError(`Не удалось получить список Android CA в ${directory}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

function validAndroidHash(value, certificate) {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(hash)) throw new SdkError(`Некорректный subject_hash_old для ${certificate.id}: ${hash || '(пусто)'}.`);
  return hash;
}

export async function resolveMagiskCertificateNames({ serial, certificates } = {}, dependencies = {}) {
  assertSerial(serial);
  if (!Array.isArray(certificates)) throw new SdkError('Не переданы публичные сертификаты для Magisk-модуля.');
  const expected = certificates.map((certificate) => {
    const checked = readPublicCertificate(certificate, { requireAndroidName: false });
    const { content, ...descriptor } = checked;
    return Object.freeze(descriptor);
  });
  if (expected.length === 0) throw new SdkError('Не переданы публичные сертификаты для Magisk-модуля.');
  const listCertificateNames = dependencies.listCertificateNames ?? defaultListCertificateNames;
  const readCertificate = dependencies.readCertificate ?? defaultReadCertificate;
  const getAndroidCertificateHash = dependencies.getAndroidCertificateHash ?? defaultAndroidCertificateHash;
  const getDeviceProperty = dependencies.getDeviceProperty ?? defaultGetDeviceProperty;
  const sdkVersion = await getDeviceProperty({ serial, key: 'ro.build.version.sdk' });
  const systemCertsEnabled = await getDeviceProperty({ serial, key: 'system.certs.enabled' });
  const systemNames = await listCertificateStore({ serial, directory: SYSTEM_CA_DIRECTORY, allowAbsent: false }, listCertificateNames);
  const apexNames = await listCertificateStore({ serial, directory: APEX_CA_DIRECTORY, allowAbsent: true }, listCertificateNames);
  const stores = Object.freeze([
    Object.freeze({ directory: SYSTEM_CA_DIRECTORY, names: new Set(systemNames) }),
    Object.freeze({ directory: APEX_CA_DIRECTORY, names: new Set(apexNames) }),
  ]);
  const activeStore = determineActiveCertificateStore({ sdkVersion, systemCertsEnabled, apexNames }) === 'apex' ? stores[1] : stores[0];
  const occupied = new Set([...systemNames, ...apexNames]);
  const resolved = [];

  for (const certificate of expected) {
    const hash = validAndroidHash(await getAndroidCertificateHash(certificate), certificate);
    const candidates = [...occupied].filter((name) => name.startsWith(`${hash}.`)).sort((left, right) => Number(left.split('.')[1]) - Number(right.split('.')[1]));
    let reusableName = null;
    for (const name of candidates) {
      let activeMatches = false;
      let collision = false;
      for (const store of stores) {
        if (!store.names.has(name)) continue;
        const certificatePath = `${store.directory}/${name}`;
        const content = await readCertificate({ serial, directory: store.directory, name, path: certificatePath });
        const fingerprint = fingerprintDeviceCertificate(content, certificatePath);
        if (fingerprint !== certificate.fingerprint) {
          collision = true;
          break;
        }
        if (store === activeStore) activeMatches = true;
      }
      if (activeMatches && !collision) {
        reusableName = name;
        break;
      }
    }
    if (reusableName) {
      resolved.push(Object.freeze({ ...certificate, androidName: reusableName, needsInstall: false }));
      continue;
    }
    let suffix = 0;
    while (occupied.has(`${hash}.${suffix}`)) suffix += 1;
    const androidName = `${hash}.${suffix}`;
    occupied.add(androidName);
    resolved.push(Object.freeze({ ...certificate, androidName, needsInstall: true }));
  }
  return Object.freeze(resolved);
}

function validateCertificates(certificates) {
  if (!Array.isArray(certificates) || certificates.length === 0) {
    throw new SdkError('Не переданы публичные сертификаты для Magisk-модуля.');
  }
  const names = new Set();
  return certificates.map((certificate) => {
    const checked = readPublicCertificate(certificate);
    if (names.has(checked.androidName)) {
      throw new SdkError(`Дубликат Android-имени сертификата в Magisk-модуле: ${checked.androidName}.`);
    }
    names.add(checked.androidName);
    return checked;
  });
}

function defaultArchive({ cwd, outputPath, entries }) {
  const result = spawnSync('zip', ['-X', '-q', '-r', outputPath, ...entries], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `zip завершился с кодом ${result.status}`).trim());
}

function uniqueTemporaryArchivePath(outputPath) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${suffix}.tmp.zip`);
}

function copyStaticAsset(name, stagingPath, mode) {
  const sourcePath = path.join(ASSET_DIRECTORY, name);
  const targetPath = path.join(stagingPath, name);
  try {
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    throw sdkError(`Не удалось подготовить статический файл Magisk ${name}: ${error.message}`, error);
  }
}

export async function buildMagiskModule({ certificates, outputPath, archive = defaultArchive } = {}) {
  assertOutputPath(outputPath);
  if (typeof archive !== 'function') throw new SdkError('Архиватор Magisk-модуля должен быть функцией.');
  const checkedCertificates = validateCertificates(certificates);
  const stagingPath = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-magisk-'));
  const temporaryOutputPath = uniqueTemporaryArchivePath(outputPath);
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    copyStaticAsset('module.prop', stagingPath, 0o644);
    copyStaticAsset('post-fs-data.sh', stagingPath, 0o755);
    copyStaticAsset('service.sh', stagingPath, 0o755);
    const caDirectory = path.join(stagingPath, 'system', 'etc', 'security', 'cacerts');
    fs.mkdirSync(caDirectory, { recursive: true, mode: 0o755 });
    for (const certificate of checkedCertificates) {
      const targetPath = path.join(caDirectory, certificate.androidName);
      fs.writeFileSync(targetPath, certificate.content, { mode: 0o644 });
      fs.chmodSync(targetPath, 0o644);
    }
    await archive({
      cwd: stagingPath,
      outputPath: temporaryOutputPath,
      entries: ['module.prop', 'post-fs-data.sh', 'service.sh', 'system'],
    });
    if (!fs.statSync(temporaryOutputPath).isFile()) {
      throw new Error('архиватор не создал ZIP-файл');
    }
    fs.renameSync(temporaryOutputPath, outputPath);
    return Object.freeze({
      outputPath,
      stagingPath,
      certificates: checkedCertificates.map(({ content, ...certificate }) => Object.freeze(certificate)),
    });
  } catch (error) {
    try {
      fs.rmSync(temporaryOutputPath, { force: true });
    } catch {}
    if (error instanceof SdkError && /^(?:Не удалось подготовить|Некоррект|В Magisk-модуль|Дубликат|Отпечаток)/.test(error.message)) throw error;
    throw sdkError(`Не удалось собрать архив Magisk-модуля: ${error instanceof Error ? error.message : String(error)}`, error);
  } finally {
    try {
      fs.rmSync(stagingPath, { recursive: true, force: true });
    } catch {}
  }
}

export async function pushMagiskModule({ serial, modulePath } = {}, dependencies = {}) {
  assertSerial(serial);
  assertOutputPath(modulePath);
  try {
    if (!fs.statSync(modulePath).isFile()) throw new Error('это не файл');
  } catch (error) {
    throw sdkError(`Не найден ZIP Magisk-модуля ${modulePath}: ${error.message}`, error);
  }
  const run = dependencies.run ?? runSdk;
  try {
    await run('adb', ['-s', serial, 'push', modulePath, REMOTE_MODULE_PATH]);
  } catch (error) {
    throw sdkError(`Не удалось скопировать Magisk-модуль в Download: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  return Object.freeze({ remotePath: REMOTE_MODULE_PATH });
}

function normalizeFingerprints(values, field) {
  if (!Array.isArray(values)) throw new SdkError(`${field} должны быть массивом отпечатков.`);
  const normalized = values.map((value) => normalizeFingerprint(typeof value === 'object' ? value?.fingerprint : value, field.slice(0, -1)));
  if (new Set(normalized).size !== normalized.length) throw new SdkError(`${field} не должны содержать дубликаты.`);
  return normalized.sort();
}

export function getMagiskModuleState(expectedFingerprints, deviceFingerprints) {
  const expected = normalizeFingerprints(expectedFingerprints, 'Ожидаемые отпечатки');
  const device = normalizeFingerprints(deviceFingerprints, 'Отпечатки на устройстве');
  if (expected.length === 0) throw new SdkError('Ожидается хотя бы один отпечаток публичного сертификата.');
  if (device.length === 0) return 'missing';
  if (expected.length !== device.length || expected.some((fingerprint, index) => fingerprint !== device[index])) return 'stale';
  return 'current';
}

export function buildMagiskManualInstructions(remotePath = REMOTE_MODULE_PATH) {
  if (remotePath !== REMOTE_MODULE_PATH) throw new SdkError('Magisk-инструкция должна ссылаться на фиксированный файл в Download.');
  return Object.freeze({
    steps: Object.freeze([
      'Откройте Magisk → Modules → Install from storage.',
      'Выберите файл Download/android-emu-ca-module.zip.',
      'После установки перезагрузите эмулятор.',
      'Повторно запустите android-emu, чтобы проверить отпечатки сертификатов.',
    ]),
    notice: 'Утилита не устанавливает Magisk, не получает root и не обходит certificate pinning.',
  });
}

function safeAvdComponent(avdName) {
  const value = String(avdName || '').trim();
  if (!value) throw new SdkError('Не указано имя AVD для Magisk-модуля.');
  const result = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+$/, 'avd').slice(0, 96);
  if (!result || result.includes('..')) throw new SdkError('Имя AVD нельзя безопасно использовать в пути Magisk-модуля.');
  return result;
}

function defaultPaths(avdName) {
  const root = path.join(os.homedir(), '.android-emu-cli', 'magisk');
  const name = safeAvdComponent(avdName);
  return {
    outputPath: path.join(root, `${name}.zip`),
    statePath: path.join(root, `${name}.json`),
  };
}

function readModuleState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return normalizeFingerprints(parsed?.fingerprints, 'Сохранённые отпечатки Magisk-модуля');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SdkError) throw error;
    throw sdkError(`Не удалось прочитать состояние Magisk-модуля ${statePath}: ${error.message}`, error);
  }
}

function writeModuleState(statePath, fingerprints) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, fingerprints })}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    throw sdkError(`Не удалось сохранить состояние Magisk-модуля ${statePath}: ${error.message}`, error);
  }
}

function sameFingerprints(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function prepareMagiskModule({ serial, avdName, certificates, outputPath, statePath } = {}, dependencies = {}) {
  assertSerial(serial);
  const defaults = defaultPaths(avdName);
  const resolvedOutputPath = outputPath ?? defaults.outputPath;
  const resolvedStatePath = statePath ?? defaults.statePath;
  assertOutputPath(resolvedOutputPath);
  if (!path.isAbsolute(String(resolvedStatePath || '')) || String(resolvedStatePath).includes('\0')) {
    throw new SdkError('Путь к состоянию Magisk-модуля должен быть абсолютным.');
  }
  const resolveNames = dependencies.resolveMagiskCertificateNames ?? resolveMagiskCertificateNames;
  let resolved;
  try {
    resolved = await resolveNames({ serial, certificates }, {
      listCertificateNames: dependencies.listCertificateNames,
      readCertificate: dependencies.readCertificate,
      getAndroidCertificateHash: dependencies.getAndroidCertificateHash,
      getDeviceProperty: dependencies.getDeviceProperty,
      ...dependencies.resolveDependencies,
    });
  } catch (error) {
    throw sdkError(`Не удалось проверить сертификаты для Magisk-модуля: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  const checkedCertificates = validateCertificates(resolved);
  const expectedFingerprints = normalizeFingerprints(checkedCertificates.map((certificate) => certificate.fingerprint), 'Ожидаемые отпечатки');
  const deviceFingerprints = checkedCertificates.filter((certificate) => certificate.needsInstall === false).map((certificate) => certificate.fingerprint);
  let state = getMagiskModuleState(expectedFingerprints, deviceFingerprints);
  const recordedFingerprints = readModuleState(resolvedStatePath);
  if (recordedFingerprints && (!sameFingerprints(recordedFingerprints, expectedFingerprints) || state === 'missing')) state = 'stale';
  const instructions = buildMagiskManualInstructions();
  if (state === 'current') return Object.freeze({ state, changed: false, instructions });

  const buildModule = dependencies.buildModule ?? buildMagiskModule;
  const pushModule = dependencies.pushModule ?? pushMagiskModule;
  const built = await buildModule({ certificates: checkedCertificates, outputPath: resolvedOutputPath, archive: dependencies.archive });
  const pushed = await pushModule({ serial, modulePath: built.outputPath }, { run: dependencies.run });
  writeModuleState(resolvedStatePath, expectedFingerprints);
  return Object.freeze({ state, changed: true, modulePath: built.outputPath, remotePath: pushed.remotePath, instructions });
}
