import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { ui } from '../ui.js';
import { prompt } from '../prompt.js';
import { selectMenu, checkNav, clearScreen, BACK } from '../menu.js';
import {
  buildMitmArgs,
  launchMitm,
  parseCliArgs,
  readMitmConfig,
  resetMitmConfig,
  writeMitmConfig,
  isPortAvailable,
  findAvailablePort,
} from '../mitm.js';

function expandPath(value) {
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

function quoteForPreview(value) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandPreview(config) {
  return ['mitmproxy', ...buildMitmArgs(config)].map(quoteForPreview).join(' ');
}

async function configureScripts(initialScripts = []) {
  const scripts = [...initialScripts];
  while (true) {
    const action = checkNav(
      await selectMenu({
        title: 'mitmproxy — скрипты',
        choices: [
          { name: 'Продолжить', value: 'continue' },
          { name: 'Добавить скрипт', value: 'add' },
          ...scripts.map((script, index) => ({
            name: `Удалить: ${script}`,
            value: `remove:${index}`,
          })),
        ],
      })
    );

    if (action === BACK || action === 'continue') return scripts;
    if (action.startsWith('remove:')) {
      scripts.splice(Number(action.split(':')[1]), 1);
      continue;
    }

    clearScreen();
    const { scriptPath } = await prompt([
      {
        type: 'input',
        name: 'scriptPath',
        message: 'Путь к Python-скрипту:',
        validate: (value) => {
          const resolved = expandPath(value);
          return (value.trim() && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) || 'Файл не найден';
        },
      },
    ]);
    const resolved = expandPath(scriptPath);
    if (!scripts.includes(resolved)) scripts.push(resolved);
  }
}

async function configureMitm(saved = {}) {
  const scripts = await configureScripts(saved.scripts);
  const base = await prompt([
    {
      type: 'number',
      name: 'listenPort',
      message: 'Порт mitmproxy:',
      default: saved.listenPort || 8080,
      validate: (value) => Number.isInteger(value) && value >= 1 && value <= 65535 || 'Введите порт от 1 до 65535',
    },
    {
      type: 'select',
      name: 'modeType',
      message: 'Режим прокси:',
      default: saved.mode?.startsWith('upstream:') ? 'upstream' : (saved.mode || 'regular'),
      choices: [
        { name: 'Обычный (regular)', value: 'regular' },
        { name: 'Вышестоящий прокси (upstream)', value: 'upstream' },
        { name: 'Прозрачный (transparent)', value: 'transparent' },
        { name: 'SOCKS5', value: 'socks5' },
      ],
    },
  ]);

  let mode = base.modeType;
  if (mode === 'upstream') {
    const upstream = await prompt([
      {
        type: 'input',
        name: 'url',
        message: 'URL вышестоящего прокси:',
        default: saved.mode?.startsWith('upstream:') ? saved.mode.slice('upstream:'.length) : '',
        validate: (value) => value.trim() !== '' || 'Введите URL прокси',
      },
    ]);
    mode = `upstream:${upstream.url.trim()}`;
  }

  const { presets, verbosity, customArgs } = await prompt([
    {
      type: 'checkbox',
      name: 'presets',
      message: 'Готовые флаги:',
      choices: [
        { name: 'Не проверять сертификат upstream (--ssl-insecure)', value: 'ssl-insecure', checked: saved.sslInsecure },
        { name: 'Разрешить внешние подключения (--set block_global=false)', value: 'allow-global', checked: saved.blockGlobal === false },
      ],
    },
    {
      type: 'select',
      name: 'verbosity',
      message: 'Подробность логов:',
      default: saved.verbosity || 0,
      choices: [
        { name: 'Обычная', value: 0 },
        { name: 'Подробная (-v)', value: 1 },
        { name: 'Очень подробная (-vv)', value: 2 },
        { name: 'Максимальная (-vvv)', value: 3 },
      ],
    },
    {
      type: 'input',
      name: 'customArgs',
      message: 'Произвольные аргументы (можно оставить пустым):',
      default: saved.customArgs || '',
      validate: (value) => {
        try {
          parseCliArgs(value);
          return true;
        } catch (err) {
          return err.message;
        }
      },
    },
  ]);

  return {
    scripts,
    listenPort: base.listenPort,
    mode,
    sslInsecure: presets.includes('ssl-insecure'),
    blockGlobal: presets.includes('allow-global') ? false : true,
    verbosity,
    customArgs: customArgs.trim(),
  };
}

async function startMitm(config) {
  if (!(await isPortAvailable(config.listenPort))) {
    const suggestedPort = await findAvailablePort(config.listenPort + 1);
    clearScreen();
    ui.warn(`Порт ${config.listenPort} уже занят.`);
    const { port } = await prompt([
      {
        type: 'number',
        name: 'port',
        message: 'Выберите другой порт:',
        default: suggestedPort,
        validate: async (value) => {
          if (!Number.isInteger(value) || value < 1 || value > 65535) return 'Введите порт от 1 до 65535';
          return (await isPortAvailable(value)) || `Порт ${value} тоже занят`;
        },
      },
    ]);
    config = { ...config, listenPort: port };
  }

  clearScreen();
  console.log(chalk.bold.cyan('Команда запуска') + '\n');
  console.log(commandPreview(config) + '\n');
  const { confirmStart } = await prompt([
    { type: 'confirm', name: 'confirmStart', message: 'Сохранить настройки и запустить?', default: true },
  ]);
  if (!confirmStart) return;

  try {
    writeMitmConfig(config);
    launchMitm(config);
    ui.success('mitmproxy запущен в новом окне Terminal.');
  } catch (err) {
    ui.error(err.message);
  }
  await ui.pause();
}

export async function mitmMenu() {
  while (true) {
    const saved = readMitmConfig();
    const action = checkNav(
      await selectMenu({
        title: 'mitmproxy',
        choices: [
          ...(saved ? [{ name: 'Запустить', value: 'run' }] : []),
          { name: 'Настроить и запустить', value: 'configure' },
          ...(saved ? [{ name: 'Сбросить настройки', value: 'reset' }] : []),
        ],
      })
    );

    if (action === BACK) return;
    if (action === 'run') {
      await startMitm(saved);
      continue;
    }
    if (action === 'configure') {
      const config = await configureMitm(saved || {});
      await startMitm(config);
      continue;
    }

    clearScreen();
    const { confirmed } = await prompt([
      { type: 'confirm', name: 'confirmed', message: 'Сбросить сохранённые настройки mitmproxy?', default: false },
    ]);
    if (confirmed) {
      resetMitmConfig();
      ui.success('Настройки сброшены.');
      await ui.pause();
    }
  }
}
