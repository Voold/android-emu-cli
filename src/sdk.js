import { spawnSync } from 'node:child_process';
import { SdkError } from './errors.js';

const REQUIRED_TOOLS = ['adb', 'avdmanager', 'emulator', 'sdkmanager'];

function isOnPath(bin) {
  const result = spawnSync('which', [bin], { encoding: 'utf8' });
  return result.status === 0;
}

export function assertSdkAvailable() {
  const missing = REQUIRED_TOOLS.filter((bin) => !isOnPath(bin));
  if (missing.length > 0) {
    throw new SdkError(
      `Не найдены инструменты Android SDK в PATH: ${missing.join(', ')}.\n` +
        '  Установите Android command line tools (например, "brew install --cask android-commandlinetools")\n' +
        '  и убедитесь, что ANDROID_HOME/cmdline-tools/latest/bin и ANDROID_HOME/emulator есть в PATH.'
    );
  }
}

/**
 * Синхронно запускает инструмент SDK и возвращает stdout.
 * Бросает SdkError с человеко-читаемым сообщением при ошибке.
 */
export function run(bin, args, { allowNonZeroExit = false, input } = {}) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    input,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new SdkError(`Команда "${bin}" не найдена. Проверьте установку Android SDK.`);
    }
    throw new SdkError(`Не удалось выполнить "${bin}": ${result.error.message}`);
  }

  if (result.status !== 0 && !allowNonZeroExit) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new SdkError(`Команда "${bin} ${args.join(' ')}" завершилась с ошибкой${details ? `:\n${details}` : '.'}`);
  }

  return result.stdout || '';
}

/**
 * Запускает инструмент интерактивно (stdio наследуется), например
 * редактор конфигурации или sdkmanager --install (там может быть запрос
 * на принятие лицензии). Возвращает код завершения.
 */
export function runInteractive(bin, args) {
  const result = spawnSync(bin, args, { stdio: 'inherit' });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new SdkError(`Команда "${bin}" не найдена.`);
    }
    throw new SdkError(`Не удалось выполнить "${bin}": ${result.error.message}`);
  }
  return result.status;
}
