import chalk from 'chalk';

// Все наши SDK-вызовы синхронные (spawnSync) и блокируют event loop, поэтому
// настоящая анимация всё равно не смогла бы отрисоваться во время ожидания —
// печатаем обычный статус вместо спиннера (заодно избегаем целого класса
// багов, связанных с перерисовкой в нестандартных терминалах).
export function spinner(text) {
  console.log(chalk.gray(`Статус: ${text}`));
  return {
    succeed: (msg) => console.log(chalk.green(`Готово: ${msg || text}`)),
    fail: (msg) => console.log(chalk.red(`Ошибка: ${msg || text}`)),
    warn: (msg) => console.log(chalk.yellow(`Внимание: ${msg || text}`)),
  };
}
