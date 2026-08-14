import chalk from 'chalk';
import inquirer from 'inquirer';

export const ui = {
  header(text) {
    console.log('\n' + chalk.bold.cyan(text));
  },
  info(text) {
    console.log(chalk.gray(text));
  },
  success(text) {
    console.log(chalk.green(`✔ ${text}`));
  },
  warn(text) {
    console.log(chalk.yellow(`⚠ ${text}`));
  },
  error(text) {
    console.log(chalk.red(`✖ ${text}`));
  },
  async pause(message = 'Нажмите Enter, чтобы продолжить…') {
    await inquirer.prompt([{ type: 'input', name: '_continue', message }]);
  },
};
