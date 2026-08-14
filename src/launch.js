import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SdkError } from './errors.js';

export const LAUNCH_FLAGS = [
  { value: 'gpu-off', label: 'Без GPU (-gpu off) — легче для слабого железа', flags: ['-gpu', 'off'] },
  { value: 'no-window', label: 'Без окна, headless (-no-window)', flags: ['-no-window'] },
  { value: 'no-audio', label: 'Без звука (-no-audio)', flags: ['-no-audio'] },
  { value: 'no-boot-anim', label: 'Без анимации загрузки (-no-boot-anim)', flags: ['-no-boot-anim'] },
  { value: 'wipe-data', label: 'Сбросить данные устройства (-wipe-data)', flags: ['-wipe-data'] },
  { value: 'no-snapshot', label: 'Полная загрузка без снапшота (-no-snapshot)', flags: ['-no-snapshot'] },
  { value: 'writable-system', label: 'Система доступна для записи (-writable-system)', flags: ['-writable-system'] },
  { value: 'proxy', label: 'Через HTTP(S)-прокси (-http-proxy)', flags: null },
];

export function buildLaunchArgs(avdName, { selectedFlagValues = [], proxy } = {}) {
  const args = ['-avd', avdName];
  for (const value of selectedFlagValues) {
    if (value === 'proxy') {
      if (proxy) args.push('-http-proxy', proxy);
      continue;
    }
    const option = LAUNCH_FLAGS.find((f) => f.value === value);
    if (option) args.push(...option.flags);
  }
  return args;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildTerminalScript(command, args, scriptPath) {
  const shellCommand = [command, ...args].map(shellQuote).join(' ');
  return `#!/bin/sh\nrm -f ${shellQuote(scriptPath)}\nexec ${shellCommand}\n`;
}

export function launchCommandInTerminal(command, args, filePrefix = 'android-emu-cli') {
  if (process.platform !== 'darwin') {
    throw new SdkError('Запуск в отдельном окне Terminal сейчас поддерживается только на macOS.');
  }

  const scriptPath = path.join(
    os.tmpdir(),
    `${filePrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`
  );
  fs.writeFileSync(scriptPath, buildTerminalScript(command, args, scriptPath), { mode: 0o700 });

  const appleScriptCommand = `bash ${shellQuote(scriptPath)}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const result = spawnSync('osascript', ['-e', `tell application "Terminal" to do script "${appleScriptCommand}"`]);
  if (result.error || result.status !== 0) {
    throw new SdkError('Не удалось открыть новое окно Terminal.');
  }
}

/**
 * Открывает новое окно Terminal.app и запускает в нём эмулятор через `exec`,
 * так что окно "владеет" процессом: закрыли окно — погас и эмулятор. Заодно
 * там же видны все логи эмулятора.
 */
export function launchEmulator(args) {
  launchCommandInTerminal('emulator', args);
}
