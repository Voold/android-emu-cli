import inquirer from 'inquirer';
import chalk from 'chalk';
import { ui } from '../ui.js';
import { listAvds, deleteAvd, openAvdConfig, avdConfigPath } from '../avd.js';
import { LAUNCH_FLAGS, buildLaunchArgs, launchEmulator } from '../launch.js';
import { getLaunchDefaults, setLaunchDefaults, clearLaunchDefaults } from '../launchDefaults.js';
import { selectMenu, checkNav, clearScreen, BACK } from '../menu.js';

async function runPlain(name) {
  const saved = getLaunchDefaults(name);
  const args = saved ? buildLaunchArgs(name, saved) : ['-avd', name];

  clearScreen();
  try {
    launchEmulator(args);
    ui.success(`Эмулятор "${name}" запускается в новом окне Terminal — закройте окно, чтобы остановить эмулятор.`);
    if (saved) {
      ui.info(`Использую сохранённые параметры по умолчанию: ${args.slice(2).join(' ') || '—'}`);
    }
  } catch (err) {
    ui.error(err.message);
  }
  await ui.pause();
}

async function runWithParams(name) {
  const saved = getLaunchDefaults(name);
  clearScreen();

  const { flags } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'flags',
      message: 'Выберите параметры запуска:',
      choices: LAUNCH_FLAGS.map((f) => ({
        name: f.label,
        value: f.value,
        checked: saved?.selectedFlagValues?.includes(f.value) ?? false,
      })),
    },
  ]);

  let proxy;
  if (flags.includes('proxy')) {
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'proxy',
        message: 'Адрес прокси (host:port или http://host:port):',
        default: saved?.proxy,
        validate: (v) => v.trim() !== '' || 'Введите адрес прокси',
      },
    ]);
    proxy = answer.proxy.trim();
  }

  const args = buildLaunchArgs(name, { selectedFlagValues: flags, proxy });
  try {
    launchEmulator(args);
    ui.success(`Эмулятор "${name}" запускается в новом окне Terminal: emulator ${args.slice(2).join(' ') || '(без доп. параметров)'}`);
  } catch (err) {
    ui.error(err.message);
    await ui.pause();
    return;
  }

  const { saveDefault } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'saveDefault',
      message: 'Сохранить эти параметры по умолчанию для этого устройства?',
      default: false,
    },
  ]);
  if (saveDefault) {
    setLaunchDefaults(name, { selectedFlagValues: flags, proxy });
    ui.success('Сохранено — обычный запуск теперь будет использовать эти параметры.');
  }
  await ui.pause();
}

async function deviceActionMenu(name) {
  while (true) {
    const action = checkNav(
      await selectMenu({
        title: `Устройство "${name}"`,
        choices: [
          { name: 'Запустить', value: 'run' },
          { name: 'Запустить с параметрами', value: 'run-params' },
          { name: 'Настроить (открыть config.ini)', value: 'configure' },
          { name: 'Удалить', value: 'delete' },
        ],
      })
    );

    if (action === BACK) return;

    if (action === 'run') {
      await runPlain(name);
      continue;
    }

    if (action === 'run-params') {
      await runWithParams(name);
      continue;
    }

    if (action === 'configure') {
      try {
        ui.info(`Открываю ${avdConfigPath(name)} ...`);
        openAvdConfig(name);
      } catch (err) {
        ui.error(err.message);
        await ui.pause();
      }
      continue;
    }

    if (action === 'delete') {
      clearScreen();
      const { confirmDelete } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmDelete',
          message: `Точно удалить "${name}"? Это необратимо.`,
          default: false,
        },
      ]);
      if (confirmDelete) {
        try {
          deleteAvd(name);
          clearLaunchDefaults(name);
          ui.success(`Устройство "${name}" удалено.`);
        } catch (err) {
          ui.error(err.message);
        }
        await ui.pause();
        return;
      }
      continue;
    }
  }
}

export async function myDevicesMenu() {
  while (true) {
    let avds;
    try {
      avds = listAvds();
    } catch (err) {
      ui.error(err.message);
      await ui.pause();
      return;
    }

    if (avds.length === 0) {
      clearScreen();
      ui.warn('Устройства не найдены. Создайте новое через главное меню.');
      await ui.pause();
      return;
    }

    const selected = checkNav(
      await selectMenu({
        title: 'Мои устройства',
        choices: avds.map((a) => ({
          name: `${a.name}  ${chalk.gray(`(${a.device || '—'}, ${a.target || '—'})`)}`,
          value: a.name,
        })),
      })
    );

    if (selected === BACK) return;
    await deviceActionMenu(selected);
  }
}
