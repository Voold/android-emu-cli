import readline from 'node:readline';
import chalk from 'chalk';
import { SdkError } from './errors.js';

export const BACK = Symbol('menu:back');
export const MAIN_MENU = Symbol('menu:main-menu');

// Бросается, когда пользователь жмёт "M" или "Esc" — ловится один раз в самом
// верху (bin/cli.js), чтобы размотать любую глубину вложенных экранов разом
// (в т.ч. прервать многошаговый мастер создания устройства на любом шаге).
export class GoToMainMenu extends Error {}

/** Превращает MAIN_MENU в исключение, которое разматывает стек до главного меню. */
export function checkNav(value) {
  if (value === MAIN_MENU) throw new GoToMainMenu();
  return value;
}

export function clearScreen() {
  if (process.stdout.isTTY) {
    // \x1b[2J\x1b[H — очистить видимый экран и вернуть курсор в начало;
    // \x1b[3J — дополнительно очистить scrollback-буфер (если терминал поддерживает).
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  }
}

const FOOTER = chalk.gray('↑↓ навигация   ⏎ выбрать   ← назад   Esc отмена   M меню   X выход');
// Заголовок и подсказки — единственное, что зафиксировано всегда. Индикаторы
// прокрутки показываются, только если список реально длиннее экрана; под них
// с запасом резервируем 2 строки при расчёте видимой области.
const CHROME_LINES = 7;
const MIN_VISIBLE = 3;
const DEFAULT_TERMINAL_ROWS = 24;

function exitProgram() {
  clearScreen();
  process.exit(0);
}

/**
 * Простое меню-список с постоянными горячими клавишами и внутренней
 * прокруткой, если список не помещается на экран. Заголовок и подсказки
 * всегда неподвижны, крутится только область пунктов между ними.
 * choices: [{ name, value }] или { separator: true, name? } для разделителя.
 * Возвращает value выбранного пункта, либо BACK, либо (через checkNav) кидает GoToMainMenu.
 */
export function selectMenu({ title, choices }) {
  const selectable = choices.filter((c) => !c.separator);
  if (selectable.length === 0) {
    throw new SdkError('Список пуст.');
  }
  let cursor = 0;
  let scrollOffset = 0;

  function visibleCount() {
    const rows = process.stdout.rows;
    const usable = Number.isInteger(rows) && rows > 0 ? rows : DEFAULT_TERMINAL_ROWS;
    return Math.max(MIN_VISIBLE, usable - CHROME_LINES);
  }

  function render() {
    clearScreen();
    console.log(chalk.bold.cyan(title));
    console.log();

    const count = visibleCount();
    const activeAbsIndex = choices.indexOf(selectable[cursor]);

    if (activeAbsIndex < scrollOffset) scrollOffset = activeAbsIndex;
    if (activeAbsIndex > scrollOffset + count - 1) scrollOffset = activeAbsIndex - count + 1;
    const maxOffset = Math.max(0, choices.length - count);
    if (scrollOffset > maxOffset) scrollOffset = maxOffset;
    if (scrollOffset < 0) scrollOffset = 0;

    if (scrollOffset > 0) {
      console.log(chalk.gray(`▲ ещё ${scrollOffset} выше`));
    }

    const visible = choices.slice(scrollOffset, scrollOffset + count);
    for (const choice of visible) {
      if (choice.separator) {
        console.log(chalk.gray(choice.name || '───────────────'));
        continue;
      }
      const isActive = choice === selectable[cursor];
      console.log(`${isActive ? chalk.cyan('❯') : ' '} ${choice.name}`);
    }

    const below = Math.max(0, choices.length - (scrollOffset + count));
    if (below > 0) {
      console.log(chalk.gray(`▼ ещё ${below} ниже`));
    }

    console.log();
    console.log(FOOTER);
  }

  render();

  return new Promise((resolve) => {
    const { stdin } = process;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write('\x1b[?25l');

    function cleanup() {
      stdin.removeListener('keypress', onKeypress);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      process.stdout.write('\x1b[?25h');
    }

    function finish(value) {
      cleanup();
      resolve(value);
    }

    function onKeypress(_str, key) {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup();
        exitProgram();
        return;
      }
      switch (key.name) {
        case 'x':
          cleanup();
          exitProgram();
          return;
        case 'm':
        case 'escape':
          finish(MAIN_MENU);
          return;
        case 'left':
        case 'backspace':
          finish(BACK);
          return;
        case 'up':
          cursor = (cursor - 1 + selectable.length) % selectable.length;
          render();
          return;
        case 'down':
          cursor = (cursor + 1) % selectable.length;
          render();
          return;
        case 'return':
        case 'enter':
          finish(selectable[cursor].value);
          return;
        default:
          return;
      }
    }

    stdin.on('keypress', onKeypress);
  });
}
