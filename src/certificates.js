import crypto, { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SdkError } from './errors.js';

const PRIVATE_KEY_BLOCK = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/;
const FINGERPRINT = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_CERT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs', 'yandex');

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    throw new SdkError(`Не удалось прочитать публичный сертификат ${filePath}: ${error.message}`);
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.version !== 1 || !Array.isArray(manifest.certificates) || manifest.certificates.length !== 2) {
    throw new SdkError('Некорректный manifest сертификатов Yandex: ожидаются две публичные записи версии 1.');
  }

  const ids = new Set();
  for (const entry of manifest.certificates) {
    const valid = entry && typeof entry === 'object' &&
      typeof entry.id === 'string' && typeof entry.file === 'string' &&
      typeof entry.source === 'string' && typeof entry.fileSha256 === 'string' &&
      typeof entry.fingerprintSha256 === 'string' && typeof entry.subject === 'string' &&
      typeof entry.validTo === 'string';
    if (!valid || ids.has(entry?.id) || path.basename(entry.file) !== entry.file || !entry.file.endsWith('.pem') || !entry.source.startsWith('https://') || !SHA256.test(entry.fileSha256) || !FINGERPRINT.test(entry.fingerprintSha256)) {
      throw new SdkError('Некорректный manifest сертификатов Yandex: запись содержит недопустимые поля.');
    }
    ids.add(entry.id);
  }
  if (!ids.has('yandex-root') || !ids.has('yandex-intermediate')) {
    throw new SdkError('Некорректный manifest сертификатов Yandex: отсутствует корневой или промежуточный сертификат.');
  }
}

function readManifest(certDir) {
  const manifestPath = path.join(certDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFile(manifestPath).toString('utf8'));
  } catch (error) {
    if (error instanceof SdkError) throw error;
    throw new SdkError(`Не удалось разобрать manifest сертификатов Yandex ${manifestPath}: ${error.message}`);
  }
  validateManifest(manifest);
  return manifest;
}

function containsPrivateKey(content) {
  return PRIVATE_KEY_BLOCK.test(content.toString('utf8'));
}

function descriptorFromFile({ id, certificatePath, source, expectedFileSha256, expectedFingerprint, expectedSubject, expectedValidTo, now }) {
  const content = readFile(certificatePath);
  if (containsPrivateKey(content)) {
    throw new SdkError(`Вместо публичного сертификата ${certificatePath} найден закрытый ключ. Удалите его и восстановите только PEM-сертификат.`);
  }
  const actualFileSha256 = sha256(content);
  if (expectedFileSha256 && actualFileSha256 !== expectedFileSha256) {
    throw new SdkError(`Контрольная сумма публичного сертификата ${certificatePath} не совпадает с manifest.`);
  }

  let x509;
  try {
    x509 = new X509Certificate(content);
  } catch (error) {
    throw new SdkError(`Файл ${certificatePath} не является корректным X.509 сертификатом: ${error.message}`);
  }
  if (x509.ca !== true) {
    throw new SdkError(`Сертификат ${certificatePath} не имеет CA basic constraints и не может устанавливаться в системное хранилище.`);
  }

  const fingerprint = x509.fingerprint256.toUpperCase();
  if (expectedFingerprint && fingerprint !== expectedFingerprint.toUpperCase()) {
    throw new SdkError(`Отпечаток публичного сертификата ${certificatePath} не совпадает с ожидаемым.`);
  }
  if (expectedSubject && x509.subject !== expectedSubject) {
    throw new SdkError(`Subject публичного сертификата ${certificatePath} не совпадает с manifest.`);
  }

  const validFrom = new Date(x509.validFrom);
  const validTo = new Date(x509.validTo);
  if (Number.isNaN(validFrom.valueOf()) || Number.isNaN(validTo.valueOf())) {
    throw new SdkError(`Не удалось определить срок действия сертификата ${certificatePath}.`);
  }
  if (expectedValidTo && validTo.toISOString() !== expectedValidTo) {
    throw new SdkError(`Срок действия публичного сертификата ${certificatePath} не совпадает с manifest.`);
  }
  if (validFrom > now) throw new SdkError(`Срок действия сертификата ${certificatePath} ещё не начался.`);
  if (validTo <= now) throw new SdkError(`Срок действия сертификата ${certificatePath} истёк ${validTo.toISOString()}. Обновите сертификаты и повторите запуск.`);

  return Object.freeze({
    id,
    path: certificatePath,
    source,
    fileSha256: actualFileSha256,
    fingerprint,
    subject: x509.subject,
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
  });
}

export function loadCertificateRegistry({
  certDir = DEFAULT_CERT_DIR,
  mitmConfDir = path.join(os.homedir(), '.mitmproxy'),
  includeMitm = true,
  now = new Date(),
} = {}) {
  const checkedNow = new Date(now);
  if (Number.isNaN(checkedNow.valueOf())) throw new SdkError('Некорректное время проверки сертификатов.');
  const manifest = readManifest(certDir);
  const certificates = manifest.certificates.map((entry) => descriptorFromFile({
    id: entry.id,
    certificatePath: path.join(certDir, entry.file),
    source: entry.source,
    expectedFileSha256: entry.fileSha256,
    expectedFingerprint: entry.fingerprintSha256,
    expectedSubject: entry.subject,
    expectedValidTo: entry.validTo,
    now: checkedNow,
  }));

  if (includeMitm) {
    certificates.push(descriptorFromFile({
      id: 'mitmproxy',
      certificatePath: path.join(mitmConfDir, 'mitmproxy-ca-cert.pem'),
      source: 'локальный публичный CA mitmproxy',
      now: checkedNow,
    }));
  }
  return Object.freeze(certificates);
}

export function getCertificateExpiryWarnings(certificates, { now = new Date(), withinDays = 180 } = {}) {
  if (!Array.isArray(certificates) || !Number.isFinite(withinDays) || withinDays < 0) {
    throw new SdkError('Некорректные параметры проверки срока действия сертификатов.');
  }
  const current = new Date(now);
  if (Number.isNaN(current.valueOf())) throw new SdkError('Некорректное время проверки сертификатов.');
  const threshold = current.valueOf() + withinDays * 24 * 60 * 60 * 1000;
  return certificates
    .filter((certificate) => new Date(certificate.validTo).valueOf() <= threshold)
    .map((certificate) => Object.freeze({
      id: certificate.id,
      validTo: certificate.validTo,
      message: `Срок действия сертификата ${certificate.id} скоро истекает: ${certificate.validTo}.`,
    }));
}

function runOpenSsl(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (result.error) throw new SdkError(`Не удалось выполнить openssl: ${result.error.message}`);
  if (result.status !== 0) throw new SdkError(`Команда openssl завершилась с ошибкой: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout || '';
}

export function androidCertificateName(certificatePath, collisionIndex = 0, run = runOpenSsl) {
  if (!String(certificatePath || '').trim() || !Number.isInteger(collisionIndex) || collisionIndex < 0 || typeof run !== 'function') {
    throw new SdkError('Некорректные параметры имени Android-сертификата.');
  }
  let output;
  try {
    output = run('openssl', ['x509', '-subject_hash_old', '-noout', '-in', certificatePath]);
  } catch (error) {
    if (error instanceof SdkError) throw error;
    throw new SdkError(`Не удалось вычислить Android hash для ${certificatePath}: ${error.message}`);
  }
  const hash = String(output).trim().split(/\s+/)[0];
  if (!/^[a-fA-F0-9]{8}$/.test(hash)) {
    throw new SdkError(`openssl вернул некорректный subject_hash_old для ${certificatePath}: ${String(output).trim() || '(пусто)'}.`);
  }
  return `${hash.toLowerCase()}.${collisionIndex}`;
}

export function assignAndroidCertificateNames(certificates, run = runOpenSsl) {
  if (!Array.isArray(certificates)) throw new SdkError('Список сертификатов для Android должен быть массивом.');
  const collisions = new Map();
  return certificates.map((certificate) => {
    const baseName = androidCertificateName(certificate.path, 0, run).slice(0, -2);
    const collisionIndex = collisions.get(baseName) ?? 0;
    collisions.set(baseName, collisionIndex + 1);
    return Object.freeze({ ...certificate, androidName: `${baseName}.${collisionIndex}` });
  });
}
