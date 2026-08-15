import chalk from 'chalk';
import { prompt } from './prompt.js';

export const ui = {
  header(text) {
    console.log('\n' + chalk.bold.cyan(text));
  },
  info(text) {
    console.log(chalk.gray(text));
  },
  success(text) {
    console.log(chalk.green(`Готово: ${text}`));
  },
  warn(text) {
    console.log(chalk.yellow(`Внимание: ${text}`));
  },
  error(text) {
    console.log(chalk.red(`Ошибка: ${text}`));
  },
  async pause(message = 'Нажмите Enter, чтобы продолжить...') {
    await prompt([{ type: 'input', name: '_continue', message }]);
  },
};
