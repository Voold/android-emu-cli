import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SdkError } from './errors.js';
import { run, runInteractive } from './sdk.js';

/**
 * Возвращает package ID системного образа из config.ini AVD. Старые AVD не
 * всегда имеют запись в настройках утилиты, поэтому это только read-only
 * fallback: неизвестный или отсутствующий путь даёт null.
 */
export function parseAvdSystemImagePackage(configText) {
  if (typeof configText !== 'string') return null;
  const value = configText.match(/^image\.sysdir\.1\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/\\+$/g, '').replace(/\/+$/g, '');
  if (!value) return null;
  const parts = value.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[0] !== 'system-images' || !/^android-\d+$/i.test(parts[1])) return null;
  if (!parts[2] || !parts[3]) return null;
  return parts.join(';');
}

export function setAvdKeyboardEnabled(configText) {
  const text = String(configText ?? '');
  const newline = text.includes('\r\n') ? '\r\n' : text.includes('\n') ? '\n' : text.includes('\r') ? '\r' : '\n';
  const hasFinalNewline = /(?:\r\n|\n|\r)$/.test(text);
  const lines = text.split(/\r\n|\n|\r/);
  if (hasFinalNewline) lines.pop();

  let keyboardSettingFound = false;
  const updatedLines = [];
  for (const line of lines) {
    if (/^\s*hw\.keyboard\s*=/.test(line)) {
      if (!keyboardSettingFound) updatedLines.push('hw.keyboard=yes');
      keyboardSettingFound = true;
    } else {
      updatedLines.push(line);
    }
  }
  if (!keyboardSettingFound) updatedLines.push('hw.keyboard=yes');
  return updatedLines.join(newline) + (hasFinalNewline ? newline : '');
}

function parseAvdList(output) {
  const [validSection] = output.split('The following Android Virtual Devices could not be loaded:');
  const blocks = validSection
    .split(/^-{3,}$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  const avds = [];
  for (const block of blocks) {
    const avd = { name: null, device: null, path: null, target: null };
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('Name:')) avd.name = line.slice('Name:'.length).trim();
      else if (line.startsWith('Device:')) avd.device = line.slice('Device:'.length).trim();
      else if (line.startsWith('Path:')) avd.path = line.slice('Path:'.length).trim();
      else if (line.startsWith('Based on:')) avd.target = line.slice('Based on:'.length).trim();
    }
    if (avd.name) avds.push(avd);
  }
  return avds;
}

export function listAvds() {
  const output = run('avdmanager', ['list', 'avd']);
  return parseAvdList(output);
}

function parseDeviceDefinitions(output) {
  const blocks = output
    .split(/^-{3,}$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  const devices = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim());
    const headerLineIdx = lines.findIndex((l) => /^id:\s*\d+\s*or\s*"[^"]+"/.test(l));
    if (headerLineIdx === -1) continue;

    const headerMatch = lines[headerLineIdx].match(/^id:\s*(\d+)\s*or\s*"([^"]+)"/);
    const [, index, stringId] = headerMatch;
    const fields = {};
    for (const line of lines.slice(headerLineIdx + 1)) {
      const m = line.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
      if (m) fields[m[1]] = m[2].trim();
    }

    devices.push({
      id: stringId || index,
      index,
      name: fields.Name || stringId || `device #${index}`,
      oem: fields.OEM || '',
      tag: fields.Tag || '',
    });
  }
  return devices;
}

export function listDeviceDefinitions() {
  const output = run('avdmanager', ['list', 'device']);
  return parseDeviceDefinitions(output);
}

export function createAvd(
  { name, systemImagePackage, deviceId },
  { execute = run, configPath = avdConfigPath(name) } = {}
) {
  const args = ['create', 'avd', '-n', name, '-k', systemImagePackage];
  if (deviceId) args.push('-d', deviceId);
  // avdmanager иногда спрашивает "Do you wish to create a custom hardware
  // profile? [no]" — отвечаем по умолчанию, чтобы не зависнуть на stdin.
  execute('avdmanager', args, { input: '\n' });
  try {
    enableAvdKeyboard(name, { configPath });
  } catch (error) {
    const partialError = new SdkError(
      `AVD "${name}" создан, но включить ввод с клавиатуры не удалось. `
      + `Откройте ${configPath} и установите hw.keyboard=yes либо удалите AVD и создайте его повторно. `
      + `Причина: ${error.message}`
    );
    partialError.avdCreated = true;
    partialError.cause = error;
    throw partialError;
  }
}

export function deleteAvd(name) {
  run('avdmanager', ['delete', 'avd', '-n', name]);
}

export function avdConfigPath(
  name,
  { environment = process.env, homeDirectory = os.homedir() } = {}
) {
  const explicitAvdHome = String(environment.ANDROID_AVD_HOME || '').trim();
  const emulatorHome = String(environment.ANDROID_EMULATOR_HOME || '').trim();
  const userHome = String(environment.ANDROID_USER_HOME || '').trim();
  const avdHome = explicitAvdHome || path.join(
    emulatorHome || userHome || path.join(homeDirectory, '.android'),
    'avd'
  );
  return path.join(avdHome, `${name}.avd`, 'config.ini');
}

export function enableAvdKeyboard(
  name,
  { configPath = avdConfigPath(name), fileSystem = fs } = {}
) {
  let temporaryPath = null;
  try {
    const current = fileSystem.readFileSync(configPath, 'utf8');
    const updated = setAvdKeyboardEnabled(current);
    if (updated === current) return false;

    temporaryPath = path.join(
      path.dirname(configPath),
      `.${path.basename(configPath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    );
    fileSystem.writeFileSync(temporaryPath, updated, { encoding: 'utf8', mode: fileSystem.statSync(configPath).mode });
    fileSystem.renameSync(temporaryPath, configPath);
    temporaryPath = null;
    return true;
  } catch (error) {
    throw new SdkError(`Не удалось включить ввод с клавиатуры для AVD "${name}" через config.ini: ${error.message}`);
  } finally {
    if (temporaryPath) {
      try {
        if (fileSystem.existsSync(temporaryPath)) fileSystem.unlinkSync(temporaryPath);
      } catch { /* основной SdkError важнее ошибки cleanup */ }
    }
  }
}

export function readAvdSystemImagePackage(name, readFile = fs.readFileSync) {
  const configPath = avdConfigPath(name);
  try {
    return parseAvdSystemImagePackage(readFile(configPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SdkError(`Не удалось прочитать config.ini AVD "${name}": ${error.message}`);
  }
}

export function openAvdConfig(name) {
  const editorCmd = process.env.VISUAL || process.env.EDITOR || 'vi';
  const [editorBin, ...editorArgs] = editorCmd.split(' ');
  return runInteractive(editorBin, [...editorArgs, avdConfigPath(name)]);
}
