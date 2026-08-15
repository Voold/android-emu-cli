import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getCertificateExpiryWarnings, loadCertificateRegistry } from './certificates.js';
import { SdkError } from './errors.js';

const REQUIRED_COMMANDS = ['adb', 'avdmanager', 'emulator', 'sdkmanager', 'mitmproxy'];
const MITMPROXY_CA_PATH = path.join(os.homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem');

function defaultCommandExists(command) {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

function defaultReadCertificate(certificatePath) {
  try {
    fs.accessSync(certificatePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultIsDirectoryReadable(directoryPath) {
  try {
    return fs.statSync(directoryPath).isDirectory() &&
      (fs.accessSync(directoryPath, fs.constants.R_OK | fs.constants.X_OK), true);
  } catch {
    return false;
  }
}

function createCheck(id, status, message, repair) {
  return { id, status, message, repair };
}

function defaultValidateBundledCertificates() {
  const certificates = loadCertificateRegistry({ includeMitm: false });
  return { certificates, warnings: getCertificateExpiryWarnings(certificates) };
}

function defaultValidateMitmCertificate({ certDir, mitmConfDir } = {}) {
  const certificates = loadCertificateRegistry({ certDir, mitmConfDir, includeMitm: true });
  const mitmCertificate = certificates.find((certificate) => certificate.id === 'mitmproxy');
  if (!mitmCertificate) throw new SdkError('В реестре отсутствует публичный сертификат mitmproxy-ca-cert.pem.');
  return mitmCertificate;
}

export function collectDoctorChecks({
  platform = process.platform,
  env = process.env,
  commandExists = defaultCommandExists,
  readCertificate = defaultReadCertificate,
  isDirectoryReadable = defaultIsDirectoryReadable,
  validateBundledCertificates = defaultValidateBundledCertificates,
  validateMitmCertificate = defaultValidateMitmCertificate,
  certDir,
  mitmConfDir,
} = {}) {
  const checks = [];
  const supportedPlatform = platform === 'darwin';
  checks.push(createCheck(
    'platform',
    supportedPlatform ? 'ok' : 'error',
    supportedPlatform ? 'macOS поддерживается.' : 'Поддерживается только macOS.',
    supportedPlatform ? null : 'Запустите android-emu на macOS.'
  ));

  const configuredSdkPaths = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(Boolean);
  const androidHome = configuredSdkPaths.find((sdkPath) => {
    try {
      return isDirectoryReadable(sdkPath);
    } catch {
      return false;
    }
  });
  checks.push(createCheck(
    'android-sdk-env',
    androidHome ? 'ok' : 'error',
    androidHome
      ? `Android SDK: ${androidHome}`
      : configuredSdkPaths.length > 0
        ? `Каталог Android SDK недоступен: ${configuredSdkPaths.join(', ')}.`
        : 'Не задан путь к Android SDK.',
    androidHome ? null : 'Укажите существующий ANDROID_HOME и добавьте инструменты SDK в PATH.'
  ));

  for (const command of REQUIRED_COMMANDS) {
    const available = commandExists(command);
    checks.push(createCheck(
      `command:${command}`,
      available ? 'ok' : 'error',
      available ? `Команда ${command} доступна.` : `Команда ${command} не найдена в PATH.`,
      available ? null : 'Запустите ./install.sh или добавьте нужную команду в PATH.'
    ));
  }

  let mitmCaError = null;
  try {
    validateMitmCertificate({ certDir, mitmConfDir });
  } catch (error) {
    mitmCaError = error;
  }
  checks.push(createCheck(
    'mitmproxy-ca',
    mitmCaError ? 'error' : 'ok',
    mitmCaError ? `Локальный сертификат mitmproxy-ca-cert.pem не прошёл проверку: ${mitmCaError.message}` : 'Локальный публичный сертификат mitmproxy-ca-cert.pem проверен.',
    mitmCaError ? 'Запустите ./install.sh или mitmproxy, чтобы создать ~/.mitmproxy/mitmproxy-ca-cert.pem без закрытого ключа.' : null
  ));

  try {
    const result = validateBundledCertificates();
    const warnings = result?.warnings ?? [];
    checks.push(createCheck(
      'yandex-certificates',
      warnings.length > 0 ? 'warning' : 'ok',
      warnings.length > 0
        ? `Сертификаты Yandex проверены, но ${warnings.map((warning) => warning.id).join(', ')} скоро истекает.`
        : 'Встроенные сертификаты Yandex проверены.',
      warnings.length > 0 ? 'Обновите публичные сертификаты Yandex в новой версии android-emu.' : null
    ));
  } catch (error) {
    checks.push(createCheck(
      'yandex-certificates',
      'error',
      `Не удалось проверить встроенные сертификаты Yandex: ${error instanceof Error ? error.message : String(error)}`,
      'Переустановите android-emu из доверенного релиза или восстановите certs/yandex/.'
    ));
  }

  return { ok: checks.every((check) => check.status !== 'error'), checks };
}

export function runDoctor(options = {}) {
  const { print = console.log, ...checkOptions } = options;
  const report = collectDoctorChecks(checkOptions);

  for (const check of report.checks) {
    print(`${check.status === 'error' ? 'Ошибка:' : check.status === 'warning' ? 'Внимание:' : 'Готово:'} ${check.message}`);
    if (check.repair) print(`  Исправление: ${check.repair}`);
  }

  return report.ok ? 0 : 1;
}
