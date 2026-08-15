#!/usr/bin/env node
import { ui } from '../src/ui.js';
import { assertSdkAvailable } from '../src/sdk.js';
import { SdkError } from '../src/errors.js';
import { selectMenu, checkNav, BACK, GoToMainMenu, clearScreen } from '../src/menu.js';
import { myDevicesMenu } from '../src/menus/myDevices.js';
import { createDeviceMenu } from '../src/menus/createDevice.js';
import { devToolsMenu } from '../src/menus/devTools.js';
import { mitmMenu } from '../src/menus/mitm.js';
import { runDoctor } from '../src/doctor.js';

async function mainMenu() {
  while (true) {
    let choice;
    try {
      choice = checkNav(
        await selectMenu({
          title: 'Android Emulator CLI',
          choices: [
            { name: 'Мои устройства', value: 'my' },
            { name: 'Создать устройство', value: 'create' },
            { name: 'Открыть DevTools', value: 'devtools' },
            { name: 'Запустить mitm', value: 'mitm' },
            { name: 'Выход', value: 'exit' },
          ],
        })
      );
    } catch (err) {
      if (err instanceof GoToMainMenu) continue;
      throw err;
    }

    if (choice === BACK) continue;
    if (choice === 'exit') break;

    try {
      if (choice === 'my') await myDevicesMenu();
      else if (choice === 'create') await createDeviceMenu();
      else if (choice === 'devtools') await devToolsMenu();
      else if (choice === 'mitm') await mitmMenu();
    } catch (err) {
      if (err instanceof GoToMainMenu) continue;
      if (err instanceof SdkError) {
        ui.error(err.message);
      } else {
        ui.error(`Непредвиденная ошибка: ${err.message}`);
      }
      await ui.pause();
    }
  }
  clearScreen();
}

if (process.argv[2] === 'doctor') {
  process.exitCode = runDoctor();
} else {
  try {
    assertSdkAvailable();
  } catch (err) {
    ui.error(err.message);
    process.exit(1);
  }

  process.on('SIGINT', () => {
    clearScreen();
    console.log('\nПрервано пользователем.');
    process.exit(0);
  });

  mainMenu().catch((err) => {
    if (err?.name === 'ExitPromptError') {
      clearScreen();
      console.log('\nПрервано пользователем.');
      process.exit(0);
    }
    ui.error(`Фатальная ошибка: ${err.message}`);
    process.exit(1);
  });
}
