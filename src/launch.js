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

function appleScriptString(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function makeScriptPath(prefix, { scriptPath, tempDir = os.tmpdir(), now = Date.now, random = Math.random } = {}) {
  if (scriptPath) return scriptPath;
  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9_.-]/g, '-');
  return path.join(tempDir, `${safePrefix}-${now()}-${random().toString(36).slice(2)}.sh`);
}

function getTerminalDeps(deps = {}) {
  return {
    platform: deps.platform ?? process.platform,
    writeFile: deps.writeFile ?? fs.writeFileSync,
    removeFile: deps.removeFile ?? ((target) => fs.rmSync(target, { force: true })),
    runAppleScript: deps.runAppleScript ?? ((script) => spawnSync('osascript', ['-e', script], { encoding: 'utf8' })),
    ...deps,
  };
}

function terminalError(message, result) {
  const details = (result?.stderr || result?.stdout || result?.error?.message || '').trim();
  return new SdkError(details ? `${message} ${details}` : message);
}

function writeTerminalScript(command, args, prefix, deps) {
  if (deps.platform !== 'darwin') {
    throw new SdkError('Запуск в отдельном окне Terminal сейчас поддерживается только на macOS.');
  }

  const scriptPath = makeScriptPath(prefix, deps);
  deps.writeFile(scriptPath, buildTerminalScript(command, args, scriptPath, deps), { mode: 0o700 });
  return scriptPath;
}

export function buildTerminalScript(command, args, scriptPath, { pidMarkerPath } = {}) {
  const shellCommand = [command, ...args].map(shellQuote).join(' ');
  const markerLine = pidMarkerPath ? `printf '%s\\n' "$$" > ${shellQuote(pidMarkerPath)}\n` : '';
  return `#!/bin/sh\nrm -f ${shellQuote(scriptPath)}\n${markerLine}exec ${shellCommand}\n`;
}

export function createTerminalWindow(command, args, prefix = 'android-emu-cli', dependencies) {
  const deps = getTerminalDeps(dependencies);
  const scriptPath = writeTerminalScript(command, args, prefix, deps);
  const shellCommand = `bash ${shellQuote(scriptPath)}`;
  const script = [
    'tell application "Terminal"',
    `set terminalTab to do script ${appleScriptString(shellCommand)}`,
    'return (id of window of terminalTab) & ":" & (tty of terminalTab)',
    'end tell',
  ].join('\n');
  const result = deps.runAppleScript(script);

  if (result?.error || result?.status !== 0) {
    try {
      deps.removeFile(scriptPath);
    } catch {
      // Первичная ошибка AppleScript важнее уборки временного скрипта.
    }
    throw terminalError('Не удалось открыть новое окно Terminal.', result);
  }

  const identifiers = String(result?.stdout || '').trim().match(/^(\d+):(.+)$/);
  const tty = identifiers?.[2]?.trim();
  if (!identifiers || Number(identifiers[1]) <= 0 || !tty) {
    throw new SdkError('Terminal не вернул корректные идентификатор окна и TTY созданной вкладки.');
  }
  return { windowId: Number(identifiers[1]), tty };
}

export function openTerminalTab(windowId, command, args, prefix = 'android-emu-cli', dependencies) {
  if (!Number.isInteger(windowId) || windowId <= 0) {
    throw new SdkError('Некорректный идентификатор окна Terminal.');
  }

  const deps = getTerminalDeps(dependencies);
  const scriptPath = writeTerminalScript(command, args, prefix, deps);
  const shellCommand = `bash ${shellQuote(scriptPath)}`;
  const script = [
    'tell application "Terminal"',
    `do script ${appleScriptString(shellCommand)} in window id ${windowId}`,
    'end tell',
  ].join('\n');
  const result = deps.runAppleScript(script);
  if (result?.error || result?.status !== 0) {
    try {
      deps.removeFile(scriptPath);
    } catch {
      // Первичная ошибка AppleScript важнее уборки временного скрипта.
    }
    throw terminalError(
      `Окно Terminal с id ${windowId} недоступно. Запуск в другом окне отменён.`,
      result
    );
  }
}

export function readTerminalTabOutput(windowId, tty, dependencies) {
  if (!Number.isInteger(windowId) || windowId <= 0 || !String(tty || '').trim()) {
    throw new SdkError('Некорректный идентификатор окна или TTY вкладки Terminal.');
  }

  const deps = getTerminalDeps(dependencies);
  if (deps.platform !== 'darwin') {
    throw new SdkError('Чтение вывода Terminal сейчас поддерживается только на macOS.');
  }
  const script = [
    'tell application "Terminal"',
    `if not (exists window id ${windowId}) then error "Окно Terminal не найдено"`,
    'set matchedTab to missing value',
    `repeat with candidateTab in tabs of window id ${windowId}`,
    `if (tty of candidateTab) is ${appleScriptString(tty)} then`,
    'set matchedTab to candidateTab',
    'exit repeat',
    'end if',
    'end repeat',
    'if matchedTab is missing value then error "Вкладка Terminal с указанным TTY не найдена"',
    'return contents of matchedTab',
    'end tell',
  ].join('\n');
  const result = deps.runAppleScript(script);
  if (result?.error || result?.status !== 0) {
    throw terminalError(`Не удалось прочитать вывод вкладки Terminal ${tty}.`, result);
  }
  return String(result?.stdout || '').trim();
}

export function launchCommandInTerminal(command, args, filePrefix = 'android-emu-cli') {
  createTerminalWindow(command, args, filePrefix);
}

/**
 * Открывает новое окно Terminal.app и запускает в нём эмулятор через `exec`,
 * так что окно "владеет" процессом: закрыли окно — погас и эмулятор. Заодно
 * там же видны все логи эмулятора.
 */
export function launchEmulator(args) {
  launchCommandInTerminal('emulator', args);
}
