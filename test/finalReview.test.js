import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLaunchRequest, getLaunchRecovery } from '../src/launchFlow.js';
import * as launchFlow from '../src/launchFlow.js';
import { createAvdWithMetadata, clearDeletedAvdMetadata } from '../src/avdLifecycle.js';

test('current config.ini image has priority over stale saved package at the Google Play boundary', () => {
  const request = resolveLaunchRequest({
    avdName: 'Pixel', globalSettings: { mitmEnabledByDefault: true }, savedDefaults: {
      systemImagePackage: 'system-images;android-34;google_apis;arm64-v8a',
    },
    parsedSystemImagePackage: 'system-images;android-34;google_apis_playstore;arm64-v8a',
  });
  assert.equal(request.systemImagePackage, 'system-images;android-34;google_apis_playstore;arm64-v8a');
  assert.equal(request.capability, 'magisk-required');
});

test('post-emulator recovery only allows cancellation without proving the old process is gone', () => {
  assert.deepEqual(getLaunchRecovery('boot'), { actions: ['cancel'], emulatorMayBeRunning: true });
  assert.deepEqual(getLaunchRecovery('validate'), { actions: ['retry', 'direct-once', 'cancel'], emulatorMayBeRunning: false });
});

test('post-emulator recovery warning only tells the user to close the AVD and start again from the menu', () => {
  assert.equal(
    launchFlow.getLaunchRecoveryWarning({ emulatorMayBeRunning: true }),
    'Эмулятор мог успеть запуститься. Закройте AVD и запустите заново из меню.'
  );
});

test('metadata failure after a successful AVD creation stays a warning and does not undo creation', () => {
  const calls = [];
  const result = createAvdWithMetadata({ name: 'Pixel', systemImagePackage: 'system-images;android-34;default;x86_64' }, {
    create: () => calls.push('create'),
    saveMetadata: () => { calls.push('metadata'); throw new Error('disk full'); },
  });
  assert.deepEqual(calls, ['create', 'metadata']);
  assert.equal(result.created, true);
  assert.match(result.metadataWarning.message, /disk full/);
});

test('delete metadata cleanup attempts launch defaults and AVD settings independently', () => {
  const calls = [];
  const errors = clearDeletedAvdMetadata('Pixel', {
    clearLaunchDefaults: () => { calls.push('launch'); throw new Error('launch blocked'); },
    clearAvdSettings: () => { calls.push('settings'); throw new Error('settings blocked'); },
  });
  assert.deepEqual(calls, ['launch', 'settings']);
  assert.deepEqual(errors.map(({ kind }) => kind), ['launch-defaults', 'avd-settings']);
});
