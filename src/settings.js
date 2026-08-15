import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SdkError } from './errors.js';

export const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), '.android-emu-cli', 'settings.json');
const MITM_OVERRIDES = new Set(['inherit', 'enabled', 'disabled']);

function readSettings(settingsPath) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new SdkError(`Некорректный формат настроек: ${settingsPath}. Ожидается JSON-объект.`);
    }
    return settings;
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    if (err instanceof SdkError) throw err;
    throw new SdkError(`Не удалось прочитать настройки: ${settingsPath}. ${err.message}`);
  }
}

function writeSettings(settings, settingsPath) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

export function getGlobalSettings(settingsPath = DEFAULT_SETTINGS_PATH) {
  const settings = readSettings(settingsPath);
  return {
    mitmEnabledByDefault:
      typeof settings.mitmEnabledByDefault === 'boolean' ? settings.mitmEnabledByDefault : true,
  };
}

export function setGlobalSettings(globalSettings, settingsPath = DEFAULT_SETTINGS_PATH) {
  writeSettings({ ...readSettings(settingsPath), ...globalSettings }, settingsPath);
}

export function getAvdSettings(avdName, settingsPath = DEFAULT_SETTINGS_PATH) {
  return readSettings(settingsPath).avds?.[avdName] || null;
}

export function setAvdSettings(avdName, updates, settingsPath = DEFAULT_SETTINGS_PATH) {
  if ('mitmOverride' in updates && !MITM_OVERRIDES.has(updates.mitmOverride)) {
    throw new SdkError(
      `Недопустимое значение mitmOverride: ${updates.mitmOverride}. Разрешены: inherit, enabled, disabled.`
    );
  }
  const settings = readSettings(settingsPath);
  settings.avds = { ...settings.avds, [avdName]: { ...settings.avds?.[avdName], ...updates } };
  writeSettings(settings, settingsPath);
}

export function clearAvdSettings(avdName, settingsPath = DEFAULT_SETTINGS_PATH) {
  const settings = readSettings(settingsPath);
  if (settings.avds?.[avdName]) {
    delete settings.avds[avdName];
    writeSettings(settings, settingsPath);
  }
}

export function resolveMitmEnabled(globalSettings = {}, avdSettings = {}, oneOff) {
  if (typeof oneOff === 'boolean') return oneOff;
  if (avdSettings?.mitmOverride === 'enabled') return true;
  if (avdSettings?.mitmOverride === 'disabled') return false;
  return globalSettings?.mitmEnabledByDefault !== false;
}
