import chalk from 'chalk';
import { ui } from '../ui.js';
import { selectMenu, checkNav, clearScreen, BACK } from '../menu.js';
import { listRunningEmulators, listDeviceTargets, openDevTools } from '../devtools.js';

function targetLabel(target) {
  const type = target.type === 'webview' ? 'WebView' : 'Chrome';
  return `${target.title}  ${chalk.gray(`(${type}, ${target.url || 'без URL'})`)}`;
}

export async function devToolsMenu() {
  clearScreen();

  let devices;
  try {
    devices = listRunningEmulators();
  } catch (err) {
    ui.error(`Не удалось получить список запущенных эмуляторов: ${err.message}`);
    await ui.pause();
    return;
  }

  if (devices.length === 0) {
    ui.warn('Запущенные эмуляторы не найдены. Сначала запустите устройство.');
    await ui.pause();
    return;
  }

  const serial = checkNav(
    await selectMenu({
      title: 'DevTools — выберите запущенное устройство',
      choices: devices.map((device) => ({
        name: `${device.name}  ${chalk.gray(`(${device.serial})`)}`,
        value: device.serial,
      })),
    })
  );
  if (serial === BACK) return;

  clearScreen();
  ui.info('Ищу доступные Chrome и WebView-вкладки...');

  let targets;
  try {
    targets = await listDeviceTargets(serial);
  } catch (err) {
    ui.error(`Не удалось подключиться к устройству: ${err.message}`);
    await ui.pause();
    return;
  }

  if (targets.length === 0) {
    ui.warn('Доступные вкладки не найдены. Откройте страницу в Chrome или включите WebView debugging в приложении.');
    await ui.pause();
    return;
  }

  let target = targets[0];
  if (targets.length > 1) {
    const targetId = checkNav(
      await selectMenu({
        title: 'DevTools — выберите вкладку',
        choices: targets.map((item, index) => ({
          name: targetLabel(item),
          value: index,
        })),
      })
    );
    if (targetId === BACK) return;
    target = targets[targetId];
  }

  try {
    openDevTools(target);
  } catch (err) {
    ui.error(`Не удалось открыть Google Chrome: ${err.message}`);
    await ui.pause();
  }
}
