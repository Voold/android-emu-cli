import test from 'node:test';
import assert from 'node:assert/strict';
import * as createDeviceMenu from '../src/menus/createDevice.js';

test('reportAvdCreationFailure distinguishes an AVD created with incomplete setup', () => {
  const events = [];
  const spinner = {
    fail(message) { events.push(['fail', message]); },
    warn(message) { events.push(['warn', message]); },
  };

  createDeviceMenu.reportAvdCreationFailure?.(spinner, { avdCreated: true });

  assert.deepEqual(events, [['warn', 'Устройство создано, но его настройка не завершена.']]);
});
