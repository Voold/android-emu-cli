import { buildLaunchArgs } from './launch.js';
import { classifySystemImage } from './imageCapabilities.js';
import { findRunningMitm } from './mitm.js';
import { resolveMitmEnabled } from './settings.js';

function withoutManualProxy(selectedFlagValues = []) {
  return selectedFlagValues.filter((value) => value !== 'proxy');
}

export function resolveLaunchRequest({
  avdName,
  globalSettings,
  avdSettings,
  savedDefaults = {},
  oneOffMitm,
  parsedSystemImagePackage,
}) {
  const mitmEnabled = resolveMitmEnabled(globalSettings, avdSettings, oneOffMitm);
  const systemImagePackage = parsedSystemImagePackage ?? savedDefaults.systemImagePackage ?? null;
  const selectedFlagValues = mitmEnabled
    ? withoutManualProxy(savedDefaults.selectedFlagValues)
    : (savedDefaults.selectedFlagValues ?? []);
  return {
    mitmEnabled,
    capability: classifySystemImage(systemImagePackage),
    systemImagePackage,
    emulatorArgs: buildLaunchArgs(avdName, {
      selectedFlagValues,
      proxy: mitmEnabled ? undefined : savedDefaults.proxy,
    }),
  };
}

export function buildPersistedLaunchDefaults({ selectedFlagValues = [], proxy, mitmOverride, mitmEnabled }) {
  const effectiveMitmEnabled = typeof mitmEnabled === 'boolean' ? mitmEnabled : mitmOverride === 'enabled';
  const flags = effectiveMitmEnabled ? withoutManualProxy(selectedFlagValues) : [...selectedFlagValues];
  const launchDefaults = { selectedFlagValues: flags };
  if (!effectiveMitmEnabled && flags.includes('proxy') && proxy) launchDefaults.proxy = proxy;
  return { launchDefaults, avdSettings: { mitmOverride } };
}

export function buildConfirmedParameterizedPersistence({ confirmed, ...selection }) {
  return confirmed ? buildPersistedLaunchDefaults(selection) : null;
}

export function resolveParameterizedLaunch({ globalSettings, avdSettings, selectedFlagValues = [], mitmOverride }) {
  const oneOffMitm = mitmOverride === 'inherit' ? undefined : mitmOverride === 'enabled';
  const mitmEnabled = resolveMitmEnabled(globalSettings, avdSettings, oneOffMitm);
  return { mitmEnabled, needsManualProxy: selectedFlagValues.includes('proxy') && !mitmEnabled, oneOffMitm };
}

export async function resolveMitmRuntime({ mitmEnabled, configuredPort }, dependencies = {}) {
  if (!mitmEnabled) return { mode: 'direct' };
  const find = dependencies.findRunningMitm ?? findRunningMitm;
  const existingMitm = find(configuredPort);
  if (existingMitm) return { mode: 'reuse', existingMitm };
  const shouldStart = await dependencies.confirmStart();
  return { mode: shouldStart ? 'start' : 'direct' };
}

export function getLaunchRecovery(stage, errorMessage = '') {
  const emulatorMayBeRunning = ['emulator', 'serial', 'boot', 'provision', 'ready'].includes(stage)
    || /\b(?:avd|emulator)\b.*(?:уже запущен|already running)|(?:уже запущен|already running).*\b(?:avd|emulator)\b/iu.test(errorMessage);
  return {
    actions: emulatorMayBeRunning ? ['cancel'] : ['retry', 'direct-once', 'cancel'],
    emulatorMayBeRunning,
  };
}

export function getLaunchRecoveryWarning(recovery) {
  return recovery?.emulatorMayBeRunning
    ? 'Эмулятор мог успеть запуститься. Закройте AVD и запустите заново из меню.'
    : null;
}

export function formatLaunchRecoveryTitle(errorMessage, warning) {
  const error = String(errorMessage || '').trim();
  const parts = ['Восстановление запуска'];
  if (error) parts.push(`Ошибка:\n${error}`);
  if (warning) parts.push(`Внимание:\n${String(warning).trim()}`);
  return parts.join('\n\n');
}

export function formatProvisionResult(result = {}, capability) {
  if (capability === 'magisk-required') {
    if (result.state === 'current') return 'Magisk: сертификаты проверены в активном хранилище.';
    const steps = result.instructions?.steps ?? [];
    return `Magisk: модуль ${result.state === 'stale' ? 'устарел и обновлён' : 'подготовлен'}. ${result.notice ?? result.instructions?.notice ?? ''} ${steps.join(' ')}`.trim();
  }
  if (capability === 'root-capable') {
    const state = result.changed ? 'сертификаты установлены или обновлены' : 'сертификаты уже актуальны';
    const warnings = result.warnings?.length ? ` Внимание: ${result.warnings.map((warning) => {
      if (typeof warning === 'string') return warning;
      return `${warning.stage ? `${warning.stage}: ` : ''}${warning.message ?? String(warning)}`;
    }).join(' ')}` : '';
    return `Root provisioning: ${state}.${warnings}`;
  }
  return 'Автоматическая установка сертификатов для этого образа не поддерживается.';
}
