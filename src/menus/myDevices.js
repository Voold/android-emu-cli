import chalk from 'chalk';
import { ui } from '../ui.js';
import { listAvds, deleteAvd, openAvdConfig, avdConfigPath, readAvdSystemImagePackage } from '../avd.js';
import { LAUNCH_FLAGS, launchEmulator } from '../launch.js';
import { getLaunchDefaults, setLaunchDefaults, clearLaunchDefaults } from '../launchDefaults.js';
import { getAvdSettings, getGlobalSettings, setAvdSettings, clearAvdSettings } from '../settings.js';
import { readMitmConfig } from '../mitm.js';
import { launchStack } from '../launchStack.js';
import { buildConfirmedParameterizedPersistence, formatProvisionResult, getLaunchRecovery, getLaunchRecoveryWarning, resolveLaunchRequest, resolveParameterizedLaunch } from '../launchFlow.js';
import { prompt } from '../prompt.js';
import { clearDeletedAvdMetadata } from '../avdLifecycle.js';
import { selectMenu, checkNav, clearScreen, BACK } from '../menu.js';

const STAGE_TITLES = {
  validate: 'проверка настроек', port: 'поиск свободного порта', mitm: 'запуск mitmproxy',
  'mitm-ready': 'ожидание mitmproxy', emulator: 'запуск эмулятора', serial: 'поиск ADB-устройства',
  boot: 'ожидание загрузки Android', provision: 'проверка сертификатов', ready: 'стек готов',
};

function stageFromError(error) {
  return String(error?.message || '').match(/Этап "([^"]+)"/)?.[1] ?? 'validate';
}

function safeMitmConfig() {
  return readMitmConfig() ?? { listenPort: 8080, mode: 'regular', scripts: [] };
}

function getRequest(name, oneOffMitm) {
  return resolveLaunchRequest({
    avdName: name,
    globalSettings: getGlobalSettings(),
    avdSettings: getAvdSettings(name),
    savedDefaults: getLaunchDefaults(name) ?? {},
    oneOffMitm,
    parsedSystemImagePackage: readAvdSystemImagePackage(name),
  });
}

function showStage(event) {
  const title = STAGE_TITLES[event.stage] ?? event.stage;
  if (event.status === 'start') ui.info(`Этап: ${title}...`);
  if (event.status === 'error') ui.error(`Этап: ${title}. ${event.error}`);
}

async function chooseRecovery(error, request) {
  const stage = stageFromError(error);
  const recovery = getLaunchRecovery(stage, error.message);
  ui.error(error.message);
  const warning = getLaunchRecoveryWarning(recovery);
  if (warning) ui.warn(warning);
  const choice = checkNav(await selectMenu({
    title: 'Восстановление запуска',
    choices: recovery.actions.map((action) => ({
      value: action,
      name: action === 'retry' ? 'Повторить MITM-запуск' : action === 'direct-once' ? 'Запустить без MITM один раз' : 'Отмена',
    })),
  }));
  if (choice === 'direct-once') {
    launchEmulator(request.emulatorArgs);
    ui.warn('Запущено без MITM только на этот раз. Настройки по умолчанию не изменены.');
    return 'done';
  }
  return choice;
}

/** Общий запуск для существующего и только что созданного AVD. */
export async function launchDevice(name, { oneOffMitm, parsedSystemImagePackage, savedDefaults } = {}) {
  let request = parsedSystemImagePackage || savedDefaults
    ? resolveLaunchRequest({
      avdName: name,
      globalSettings: getGlobalSettings(),
      avdSettings: getAvdSettings(name),
      savedDefaults: savedDefaults ?? getLaunchDefaults(name) ?? {},
      oneOffMitm,
      parsedSystemImagePackage,
    })
    : getRequest(name, oneOffMitm);

  while (true) {
    clearScreen();
    try {
      if (!request.mitmEnabled) {
        launchEmulator(request.emulatorArgs);
        ui.success(`Эмулятор "${name}" запущен без MITM в новом окне Terminal.`);
        return { direct: true };
      }
      const result = await launchStack({
        avdName: name,
        capability: request.capability,
        emulatorArgs: request.emulatorArgs,
        mitmConfig: safeMitmConfig(),
        onStage: showStage,
      });
      ui.success(`MITM-стек для "${name}" готов. Порт: ${result.port}.`);
      ui.info(formatProvisionResult(result.provision, result.capability));
      return result;
    } catch (error) {
      const action = await chooseRecovery(error, request);
      if (action === 'done' || action === 'cancel' || action === BACK) return null;
      request = savedDefaults
        ? resolveLaunchRequest({ avdName: name, globalSettings: getGlobalSettings(), avdSettings: getAvdSettings(name), savedDefaults, oneOffMitm, parsedSystemImagePackage })
        : getRequest(name, oneOffMitm);
    }
  }
}

async function runPlain(name) {
  await launchDevice(name);
  await ui.pause();
}

async function runWithParams(name) {
  const saved = getLaunchDefaults(name) ?? {};
  clearScreen();
  const { flags } = await prompt([{
    type: 'checkbox', name: 'flags', message: 'Выберите параметры запуска:',
    choices: LAUNCH_FLAGS.map((flag) => ({
      name: flag.label, value: flag.value, checked: saved.selectedFlagValues?.includes(flag.value) ?? false,
    })),
  }]);
  const { mitmOverride } = await prompt([{
    type: 'select', name: 'mitmOverride', message: 'MITM для этого запуска:',
    choices: [
      { name: 'Наследовать настройку устройства', value: 'inherit' },
      { name: 'Включить MITM', value: 'enabled' },
      { name: 'Выключить MITM', value: 'disabled' },
    ],
    default: getAvdSettings(name)?.mitmOverride ?? 'inherit',
  }]);

  const parameterized = resolveParameterizedLaunch({
    globalSettings: getGlobalSettings(), avdSettings: getAvdSettings(name), selectedFlagValues: flags, mitmOverride,
  });
  let proxy;
  if (parameterized.needsManualProxy) {
    ({ proxy } = await prompt([{
      type: 'input', name: 'proxy', message: 'Адрес прокси (host:port или http://host:port):', default: saved.proxy,
      validate: (value) => value.trim() !== '' || 'Введите адрес прокси',
    }]));
    proxy = proxy.trim();
  }
  if (flags.includes('proxy') && parameterized.mitmEnabled) {
    ui.warn('При MITM ручной proxy не используется: адрес mitmproxy выбирается динамически и не сохраняется.');
  }

  const runtimeDefaults = { ...saved, selectedFlagValues: flags, proxy };
  const request = resolveLaunchRequest({
    avdName: name, globalSettings: getGlobalSettings(), avdSettings: getAvdSettings(name),
    oneOffMitm: parameterized.oneOffMitm, savedDefaults: runtimeDefaults, parsedSystemImagePackage: readAvdSystemImagePackage(name),
  });
  const { saveDefault } = await prompt([{
    type: 'confirm', name: 'saveDefault', message: 'Сохранить выбранные параметры по умолчанию для этого устройства?', default: false,
  }]);
  const persisted = buildConfirmedParameterizedPersistence({
    confirmed: saveDefault, selectedFlagValues: flags, proxy, mitmOverride, mitmEnabled: request.mitmEnabled,
  });
  if (persisted) {
    setLaunchDefaults(name, { ...persisted.launchDefaults, systemImagePackage: request.systemImagePackage ?? saved.systemImagePackage });
    setAvdSettings(name, persisted.avdSettings);
    ui.success('Параметры и режим MITM сохранены независимо друг от друга.');
  }
  await launchDevice(name, { oneOffMitm: parameterized.oneOffMitm, savedDefaults: runtimeDefaults, parsedSystemImagePackage: request.systemImagePackage });
  await ui.pause();
}

async function deviceActionMenu(name) {
  while (true) {
    const action = checkNav(await selectMenu({ title: `Устройство "${name}"`, choices: [
      { name: 'Запустить', value: 'run' }, { name: 'Запустить с параметрами', value: 'run-params' },
      { name: 'Настроить (открыть config.ini)', value: 'configure' }, { name: 'Удалить', value: 'delete' },
    ] }));
    if (action === BACK) return;
    if (action === 'run') { await runPlain(name); continue; }
    if (action === 'run-params') { await runWithParams(name); continue; }
    if (action === 'configure') {
      try { ui.info(`Открываю ${avdConfigPath(name)} ...`); openAvdConfig(name); } catch (error) { ui.error(error.message); await ui.pause(); }
      continue;
    }
    if (action === 'delete') {
      clearScreen();
      const { confirmDelete } = await prompt([{ type: 'confirm', name: 'confirmDelete', message: `Точно удалить "${name}"? Это необратимо.`, default: false }]);
      if (!confirmDelete) continue;
      try {
        deleteAvd(name);
        const cleanupErrors = clearDeletedAvdMetadata(name, { clearLaunchDefaults, clearAvdSettings });
        ui.success(`Устройство "${name}" удалено.`);
        for (const cleanupError of cleanupErrors) {
          ui.warn(`Не удалось очистить ${cleanupError.kind}: ${cleanupError.error.message}`);
        }
      } catch (error) { ui.error(error.message); }
      await ui.pause(); return;
    }
  }
}

export async function myDevicesMenu() {
  while (true) {
    let avds;
    try { avds = listAvds(); } catch (error) { ui.error(error.message); await ui.pause(); return; }
    if (avds.length === 0) { clearScreen(); ui.warn('Устройства не найдены. Создайте новое через главное меню.'); await ui.pause(); return; }
    const selected = checkNav(await selectMenu({ title: 'Мои устройства', choices: avds.map((avd) => ({
      name: `${avd.name}  ${chalk.gray(`(${avd.device || '—'}, ${avd.target || '—'})`)}`, value: avd.name,
    })) }));
    if (selected === BACK) return;
    await deviceActionMenu(selected);
  }
}
