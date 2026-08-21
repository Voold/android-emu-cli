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

test('imageChoice keeps firmware entries compact and omits the long description', () => {
  assert.deepEqual(createDeviceMenu.imageChoice({
    package: 'system-images;android-35;google_apis;arm64-v8a',
    apiLevel: 35,
    tag: 'google_apis',
    abi: 'arm64-v8a',
    installed: true,
    description: 'Google APIs ARM 64 v8a System Image with a very long description',
  }), {
    name: '◆ API 35  google_apis/arm64-v8a  установлен  root-capable',
    value: 'system-images;android-35;google_apis;arm64-v8a',
  });

  assert.deepEqual(createDeviceMenu.imageChoice({
    package: 'system-images;android-36;google_apis_playstore;arm64-v8a',
    apiLevel: 36,
    tag: 'google_apis_playstore',
    abi: 'arm64-v8a',
    installed: false,
    description: 'Google Play ARM 64 v8a System Image with a very long description',
  }), {
    name: '◇ API 36  google_apis_playstore/arm64-v8a  не установлен  magisk-required',
    value: 'system-images;android-36;google_apis_playstore;arm64-v8a',
  });
});
