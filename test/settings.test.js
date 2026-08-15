import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getGlobalSettings,
  resolveMitmEnabled,
  setAvdSettings,
  setGlobalSettings,
} from '../src/settings.js';
import { clearLaunchDefaults, getLaunchDefaults, setLaunchDefaults } from '../src/launchDefaults.js';
import { SdkError } from '../src/errors.js';

function makeTempPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-settings-test-'));
  return { dir, file: path.join(dir, name) };
}

test('getGlobalSettings enables MITM by default when the settings file is absent', () => {
  const { dir, file } = makeTempPath('settings.json');

  assert.deepEqual(getGlobalSettings(file), { mitmEnabledByDefault: true });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('setGlobalSettings rejects malformed JSON and does not overwrite it', () => {
  const { dir, file } = makeTempPath('settings.json');
  const malformed = '{"mitmEnabledByDefault":';
  fs.writeFileSync(file, malformed);

  assert.throws(
    () => setGlobalSettings({ mitmEnabledByDefault: false }, file),
    (err) => err instanceof SdkError && /Не удалось прочитать настройки/.test(err.message) && err.message.includes(file)
  );
  assert.equal(fs.readFileSync(file, 'utf8'), malformed);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('setAvdSettings rejects non-object JSON and does not overwrite it', () => {
  const { dir, file } = makeTempPath('settings.json');
  const invalidRoot = '[]';
  fs.writeFileSync(file, invalidRoot);

  assert.throws(
    () => setAvdSettings('Pixel_8', { mitmOverride: 'enabled' }, file),
    (err) => err instanceof SdkError && /Некорректный формат настроек/.test(err.message) && err.message.includes(file)
  );
  assert.equal(fs.readFileSync(file, 'utf8'), invalidRoot);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('getGlobalSettings rejects an unreadable settings file with its path', () => {
  const { dir, file } = makeTempPath('settings.json');
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o000);

  try {
    assert.throws(
      () => getGlobalSettings(file),
      (err) => err instanceof SdkError && /Не удалось прочитать настройки/.test(err.message) && err.message.includes(file)
    );
  } finally {
    fs.chmodSync(file, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveMitmEnabled respects global default, tri-state AVD override, and one-off override without mutation', () => {
  const globalSettings = Object.freeze({ mitmEnabledByDefault: false });
  const inherit = Object.freeze({ mitmOverride: 'inherit' });
  const enabled = Object.freeze({ mitmOverride: 'enabled' });
  const disabled = Object.freeze({ mitmOverride: 'disabled' });

  assert.equal(resolveMitmEnabled(globalSettings, inherit), false);
  assert.equal(resolveMitmEnabled(globalSettings, enabled), true);
  assert.equal(resolveMitmEnabled(globalSettings, disabled), false);
  assert.equal(resolveMitmEnabled(globalSettings, disabled, true), true);
  assert.equal(resolveMitmEnabled({ mitmEnabledByDefault: true }, enabled, false), false);
  assert.deepEqual(globalSettings, { mitmEnabledByDefault: false });
  assert.deepEqual(disabled, { mitmOverride: 'disabled' });
});

test('setAvdSettings persists each allowed MITM override exactly', () => {
  const { dir, file } = makeTempPath('settings.json');

  for (const mitmOverride of ['inherit', 'enabled', 'disabled']) {
    setAvdSettings('Pixel_8', { mitmOverride }, file);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.avds.Pixel_8.mitmOverride, mitmOverride);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('setAvdSettings rejects an invalid MITM override without rewriting settings', () => {
  const { dir, file } = makeTempPath('settings.json');
  const original = JSON.stringify({ avds: { Pixel_8: { customField: 'keep' } } });
  fs.writeFileSync(file, original);

  assert.throws(
    () => setAvdSettings('Pixel_8', { mitmOverride: 'auto' }, file),
    (err) => err instanceof SdkError && /Недопустимое значение/.test(err.message) && /mitmOverride/.test(err.message)
  );
  assert.equal(fs.readFileSync(file, 'utf8'), original);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('setLaunchDefaults migrates old records without discarding flags, proxy, or unknown fields', () => {
  const { dir, file } = makeTempPath('launch-defaults.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      Pixel_8: {
        selectedFlagValues: ['no-window', 'proxy'],
        proxy: 'http://127.0.0.1:8080',
        systemImagePackage: 'system-images;android-34;google_apis;arm64-v8a',
        customField: 'preserve me',
      },
    })
  );

  setLaunchDefaults('Pixel_8', { mitmOverride: 'disabled' }, file);

  assert.deepEqual(getLaunchDefaults('Pixel_8', file), {
    selectedFlagValues: ['no-window', 'proxy'],
    proxy: 'http://127.0.0.1:8080',
    systemImagePackage: 'system-images;android-34;google_apis;arm64-v8a',
    customField: 'preserve me',
    mitmOverride: 'disabled',
  });

  clearLaunchDefaults('Pixel_8', file);
  assert.equal(getLaunchDefaults('Pixel_8', file), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('launch defaults reject malformed JSON and never overwrite it', () => {
  const { dir, file } = makeTempPath('launch-defaults.json');
  const malformed = '{"Pixel_8":';
  fs.writeFileSync(file, malformed);

  assert.throws(
    () => setLaunchDefaults('Pixel_8', { selectedFlagValues: ['no-audio'] }, file),
    (err) => err instanceof SdkError && /Не удалось прочитать параметры запуска/.test(err.message) && err.message.includes(file)
  );
  assert.equal(fs.readFileSync(file, 'utf8'), malformed);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('launch defaults reject a non-object root and never overwrite it', () => {
  const { dir, file } = makeTempPath('launch-defaults.json');
  fs.writeFileSync(file, '[]');

  assert.throws(
    () => getLaunchDefaults('Pixel_8', file),
    (err) => err instanceof SdkError && /Некорректный формат параметров запуска/.test(err.message)
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '[]');
  fs.rmSync(dir, { recursive: true, force: true });
});
