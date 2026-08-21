import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPersistedLaunchDefaults,
  buildConfirmedParameterizedPersistence,
  formatProvisionResult,
  getLaunchRecovery,
  resolveParameterizedLaunch,
  resolveLaunchRequest,
} from '../src/launchFlow.js';
import * as launchFlow from '../src/launchFlow.js';

test('plain launch combines saved defaults, inherited MITM and parsed existing-AVD capability', () => {
  assert.deepEqual(
    resolveLaunchRequest({
      avdName: 'Pixel_36',
      globalSettings: { mitmEnabledByDefault: true },
      avdSettings: { mitmOverride: 'inherit' },
      savedDefaults: { selectedFlagValues: ['no-audio', 'proxy'], proxy: 'http://stale:8080' },
      parsedSystemImagePackage: 'system-images;android-36;default;arm64-v8a',
    }),
    {
      mitmEnabled: true,
      capability: 'root-capable',
      systemImagePackage: 'system-images;android-36;default;arm64-v8a',
      emulatorArgs: ['-avd', 'Pixel_36', '-no-audio'],
    }
  );
});

test('one-off override changes only this launch and does not produce persistence data', () => {
  const request = resolveLaunchRequest({
    avdName: 'Play_30',
    globalSettings: { mitmEnabledByDefault: true },
    avdSettings: { mitmOverride: 'enabled' },
    oneOffMitm: false,
    savedDefaults: { selectedFlagValues: ['no-window'] },
    parsedSystemImagePackage: 'system-images;android-30;google_apis_playstore;arm64-v8a',
  });

  assert.equal(request.mitmEnabled, false);
  assert.equal(request.capability, 'magisk-required');
  assert.deepEqual(request.emulatorArgs, ['-avd', 'Play_30', '-no-window']);
});

test('saved parameterized MITM defaults exclude a stale manual proxy and keep the override independent', () => {
  assert.deepEqual(
    buildPersistedLaunchDefaults({
      selectedFlagValues: ['no-audio', 'proxy'],
      proxy: 'http://manual-proxy:8080',
      mitmOverride: 'enabled',
    }),
    {
      launchDefaults: { selectedFlagValues: ['no-audio'] },
      avdSettings: { mitmOverride: 'enabled' },
    }
  );
});

test('saved direct defaults retain an explicitly selected manual proxy', () => {
  assert.deepEqual(
    buildPersistedLaunchDefaults({
      selectedFlagValues: ['no-window', 'proxy'],
      proxy: 'http://manual-proxy:8080',
      mitmOverride: 'disabled',
    }),
    {
      launchDefaults: { selectedFlagValues: ['no-window', 'proxy'], proxy: 'http://manual-proxy:8080' },
      avdSettings: { mitmOverride: 'disabled' },
    }
  );
});

test('parameterized persistence is absent until an explicit confirmation', () => {
  assert.equal(
    buildConfirmedParameterizedPersistence({ confirmed: false, selectedFlagValues: ['no-audio'], mitmOverride: 'enabled', mitmEnabled: true }),
    null
  );
  assert.deepEqual(
    buildConfirmedParameterizedPersistence({ confirmed: true, selectedFlagValues: ['no-audio'], mitmOverride: 'enabled', mitmEnabled: true }),
    { launchDefaults: { selectedFlagValues: ['no-audio'] }, avdSettings: { mitmOverride: 'enabled' } }
  );
});

test('inherited MITM strips a manual proxy when the effective global setting is enabled', () => {
  assert.deepEqual(
    buildPersistedLaunchDefaults({
      selectedFlagValues: ['proxy'], proxy: 'http://manual-proxy:8080', mitmOverride: 'inherit', mitmEnabled: true,
    }),
    { launchDefaults: { selectedFlagValues: [] }, avdSettings: { mitmOverride: 'inherit' } }
  );
});

test('inherited MITM retains a manual proxy when the effective global setting is disabled', () => {
  assert.deepEqual(
    buildPersistedLaunchDefaults({
      selectedFlagValues: ['proxy'], proxy: 'http://manual-proxy:8080', mitmOverride: 'inherit', mitmEnabled: false,
    }),
    {
      launchDefaults: { selectedFlagValues: ['proxy'], proxy: 'http://manual-proxy:8080' },
      avdSettings: { mitmOverride: 'inherit' },
    }
  );
});

test('parameterized inherit launch asks for a manual proxy only when global MITM is effectively disabled', () => {
  assert.deepEqual(
    resolveParameterizedLaunch({
      globalSettings: { mitmEnabledByDefault: false }, avdSettings: { mitmOverride: 'inherit' },
      selectedFlagValues: ['proxy'], mitmOverride: 'inherit',
    }),
    { mitmEnabled: false, needsManualProxy: true, oneOffMitm: undefined }
  );
  assert.deepEqual(
    resolveParameterizedLaunch({
      globalSettings: { mitmEnabledByDefault: true }, avdSettings: { mitmOverride: 'inherit' },
      selectedFlagValues: ['proxy'], mitmOverride: 'inherit',
    }),
    { mitmEnabled: true, needsManualProxy: false, oneOffMitm: undefined }
  );
});

test('recovery never offers a duplicate direct launch after the emulator stage', () => {
  assert.deepEqual(getLaunchRecovery('port'), { actions: ['retry', 'direct-once', 'cancel'], emulatorMayBeRunning: false });
  assert.deepEqual(getLaunchRecovery('boot'), { actions: ['cancel'], emulatorMayBeRunning: true });
  assert.deepEqual(
    getLaunchRecovery('validate', 'Этап "validate": AVD "Pixel_8" уже запущен (emulator-5554).'),
    { actions: ['cancel'], emulatorMayBeRunning: true }
  );
});

test('recovery menu title keeps the original launch error visible after redraw', () => {
  assert.equal(typeof launchFlow.formatLaunchRecoveryTitle, 'function');
  assert.equal(
    launchFlow.formatLaunchRecoveryTitle(
      'Этап "provision": cp: missing destination file operand',
      'Эмулятор мог успеть запуститься.'
    ),
    'Восстановление запуска\n\nОшибка:\nЭтап "provision": cp: missing destination file operand\n\nВнимание:\nЭмулятор мог успеть запуститься.'
  );
});

test('provision results remain explicit about manual Magisk and root state', () => {
  assert.match(formatProvisionResult({ state: 'current' }, 'magisk-required'), /проверен/i);
  assert.match(formatProvisionResult({ state: 'missing', instructions: { steps: ['Откройте Magisk'] } }, 'magisk-required'), /Откройте Magisk/);
  assert.match(
    formatProvisionResult({ changed: true, warnings: [{ stage: 'remount', message: 'Требуется перезагрузка' }] }, 'root-capable'),
    /remount.*Требуется перезагрузка/iu
  );
  assert.match(
    formatProvisionResult({ state: 'missing', instructions: { notice: 'Установите модуль вручную', steps: ['Откройте Magisk'] } }, 'magisk-required'),
    /Установите модуль вручную/iu
  );
});

test('resolveMitmRuntime reuses a listener without prompting and asks only when none is running', async () => {
  assert.equal(typeof launchFlow.resolveMitmRuntime, 'function');
  let prompts = 0;
  const running = { pid: 41, name: 'mitmproxy', port: 8081 };

  assert.deepEqual(await launchFlow.resolveMitmRuntime({ mitmEnabled: false, configuredPort: 8080 }, {
    findRunningMitm: () => { throw new Error('disabled MITM must not inspect processes'); },
    confirmStart: async () => { throw new Error('disabled MITM must not prompt'); },
  }), { mode: 'direct' });

  assert.deepEqual(await launchFlow.resolveMitmRuntime({ mitmEnabled: true, configuredPort: 8080 }, {
    findRunningMitm: () => running,
    confirmStart: async () => { throw new Error('running MITM must not prompt'); },
  }), { mode: 'reuse', existingMitm: running });

  assert.deepEqual(await launchFlow.resolveMitmRuntime({ mitmEnabled: true, configuredPort: 8080 }, {
    findRunningMitm: () => null,
    confirmStart: async () => { prompts += 1; return true; },
  }), { mode: 'start' });
  assert.deepEqual(await launchFlow.resolveMitmRuntime({ mitmEnabled: true, configuredPort: 8080 }, {
    findRunningMitm: () => null,
    confirmStart: async () => { prompts += 1; return false; },
  }), { mode: 'direct' });
  assert.equal(prompts, 2);
});
