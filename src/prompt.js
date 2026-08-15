import readline from 'node:readline';
import inquirer from 'inquirer';
import { GoToMainMenu, clearScreen } from './menu.js';

export function withEscHint(message) {
  return `${message} (Esc — отмена)`;
}

/**
 * Inquirer не превращает Escape в ExitPromptError. Слушаем keypress на том же
 * input, закрываем только свой UI и отличаем этот AbortPromptError от чужого.
 */
export async function prompt(questions, dependencies = {}) {
  const input = dependencies.input ?? process.stdin;
  const ask = dependencies.inquirer ?? inquirer;
  const clear = dependencies.clearScreen ?? clearScreen;
  const exit = dependencies.exit ?? ((code) => process.exit(code));
  const promptPromise = ask.prompt(questions.map((question) => ({
    ...question,
    message: question.escHint === false ? question.message : withEscHint(question.message),
  })));
  let reason = null;

  readline.emitKeypressEvents(input);
  const onKeypress = (_value, key) => {
    if (!key) return;
    if (key.name === 'escape' || key.name === 'm') reason = 'main-menu';
    else if (key.name === 'x') {
      reason = 'exit';
      clear();
      exit(0);
    } else return;
    promptPromise.ui?.close?.();
  };
  input.on('keypress', onKeypress);
  try {
    return await promptPromise;
  } catch (error) {
    if (reason === 'main-menu' && error?.name === 'AbortPromptError') throw new GoToMainMenu();
    if (reason === 'exit' && error?.name === 'AbortPromptError') return undefined;
    throw error;
  } finally {
    input.removeListener('keypress', onKeypress);
  }
}
