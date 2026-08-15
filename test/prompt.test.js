import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GoToMainMenu } from '../src/menu.js';
import { prompt } from '../src/prompt.js';

function makeAbortablePrompt() {
  let reject;
  const pending = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
  pending.ui = { close: () => reject(Object.assign(new Error('closed'), { name: 'AbortPromptError' })) };
  return pending;
}

test('prompt turns an explicit Escape into GoToMainMenu and removes its temporary listener', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const pending = makeAbortablePrompt();
  const promise = prompt([{ type: 'input', name: 'name', message: 'Имя' }], {
    input,
    inquirer: { prompt: () => pending },
  });

  input.emit('keypress', '', { name: 'escape' });
  await assert.rejects(promise, (error) => error instanceof GoToMainMenu);
  assert.equal(input.listenerCount('keypress'), 0);
});

test('prompt does not reinterpret an unrelated AbortPromptError as navigation', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const abort = Promise.reject(Object.assign(new Error('other close'), { name: 'AbortPromptError' }));
  abort.ui = { close: () => {} };
  await assert.rejects(
    prompt([{ type: 'input', name: 'name', message: 'Имя' }], { input, inquirer: { prompt: () => abort } }),
    /other close/
  );
  assert.equal(input.listenerCount('keypress'), 0);
});

test('prompt clears the console and delegates X exit through the injected exit function', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const pending = makeAbortablePrompt();
  let cleared = 0;
  let exited = 0;
  const promise = prompt([{ type: 'input', name: 'name', message: 'Имя' }], {
    input,
    inquirer: { prompt: () => pending },
    clearScreen: () => { cleared += 1; },
    exit: () => { exited += 1; },
  });
  input.emit('keypress', 'x', { name: 'x' });
  assert.equal(await promise, undefined);
  assert.equal(cleared, 1);
  assert.equal(exited, 1);
  assert.equal(input.listenerCount('keypress'), 0);
});

test('prompt turns M into GoToMainMenu and cleans up its listener', async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const pending = makeAbortablePrompt();
  const promise = prompt([{ type: 'input', name: 'name', message: 'Имя' }], {
    input, inquirer: { prompt: () => pending },
  });
  input.emit('keypress', 'm', { name: 'm' });
  await assert.rejects(promise, (error) => error instanceof GoToMainMenu);
  assert.equal(input.listenerCount('keypress'), 0);
});
