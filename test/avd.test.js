import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as avd from '../src/avd.js';
import { SdkError } from '../src/errors.js';

const { parseAvdSystemImagePackage } = avd;

test('parseAvdSystemImagePackage normalizes a default image.sysdir.1 path', () => {
  assert.equal(
    parseAvdSystemImagePackage('avd.ini.encoding=UTF-8\nimage.sysdir.1=system-images/android-36/default/arm64-v8a/\n'),
    'system-images;android-36;default;arm64-v8a'
  );
});

test('parseAvdSystemImagePackage recognizes Google Play config paths without a trailing slash', () => {
  assert.equal(
    parseAvdSystemImagePackage('image.sysdir.1=system-images/android-30/google_apis_playstore/arm64-v8a'),
    'system-images;android-30;google_apis_playstore;arm64-v8a'
  );
});

test('parseAvdSystemImagePackage returns null for an absent or unknown image path', () => {
  assert.equal(parseAvdSystemImagePackage('hw.ramSize=2048\n'), null);
  assert.equal(parseAvdSystemImagePackage('image.sysdir.1=vendor-images/android-36/default/arm64-v8a/'), null);
});

test('avdConfigPath honors ANDROID_AVD_HOME', () => {
  assert.equal(
    avd.avdConfigPath('Pixel_8', {
      environment: { ANDROID_AVD_HOME: '/custom/android-avds' },
      homeDirectory: '/users/tester',
    }),
    '/custom/android-avds/Pixel_8.avd/config.ini'
  );
});

test('avdConfigPath follows Android emulator and user home fallbacks', () => {
  assert.equal(
    avd.avdConfigPath('Pixel_8', {
      environment: {
        ANDROID_EMULATOR_HOME: '/custom/emulator-home',
        ANDROID_USER_HOME: '/custom/user-home',
      },
      homeDirectory: '/users/tester',
    }),
    '/custom/emulator-home/avd/Pixel_8.avd/config.ini'
  );
  assert.equal(
    avd.avdConfigPath('Pixel_8', {
      environment: { ANDROID_USER_HOME: '/custom/user-home' },
      homeDirectory: '/users/tester',
    }),
    '/custom/user-home/avd/Pixel_8.avd/config.ini'
  );
});

test('setAvdKeyboardEnabled leaves exactly one enabled keyboard setting', () => {
  assert.equal(
    avd.setAvdKeyboardEnabled?.('hw.ramSize=2048\nhw.keyboard=no\nshowDeviceFrame=yes\nhw.keyboard = no\n'),
    'hw.ramSize=2048\nhw.keyboard=yes\nshowDeviceFrame=yes\n'
  );
});

test('setAvdKeyboardEnabled appends a missing setting and preserves CRLF', () => {
  assert.equal(
    avd.setAvdKeyboardEnabled('hw.ramSize=2048\r\nshowDeviceFrame=yes\r\n'),
    'hw.ramSize=2048\r\nshowDeviceFrame=yes\r\nhw.keyboard=yes\r\n'
  );
});

test('setAvdKeyboardEnabled preserves bare CR line endings', () => {
  assert.equal(
    avd.setAvdKeyboardEnabled('hw.keyboard=no\rhw.ramSize=2048\r'),
    'hw.keyboard=yes\rhw.ramSize=2048\r'
  );
});

test('enableAvdKeyboard updates a real config file once', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-keyboard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.ini');
  fs.writeFileSync(configPath, 'hw.keyboard=no\nhw.ramSize=2048\n');

  assert.equal(avd.enableAvdKeyboard?.('Pixel_8', { configPath }), true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'hw.keyboard=yes\nhw.ramSize=2048\n');
  assert.equal(avd.enableAvdKeyboard('Pixel_8', { configPath }), false);
});

test('enableAvdKeyboard reports the AVD when config.ini cannot be read', () => {
  assert.throws(
    () => avd.enableAvdKeyboard('Missing_Pixel', { configPath: '/missing-avd/config.ini' }),
    (error) => error instanceof SdkError && /Missing_Pixel/.test(error.message) && /config\.ini/.test(error.message)
  );
});

test('enableAvdKeyboard writes a same-directory temp file before atomic rename', () => {
  const configPath = '/virtual/Pixel_8.avd/config.ini';
  const events = [];
  let temporaryPath;
  let finalContent = 'hw.keyboard=no\n';
  const fileSystem = {
    readFileSync(candidate, encoding) {
      events.push(['read', candidate, encoding]);
      return finalContent;
    },
    statSync(candidate) {
      events.push(['stat', candidate]);
      return { mode: 0o100644 };
    },
    writeFileSync(candidate, content, options) {
      temporaryPath = candidate;
      events.push(['write', candidate, content, options]);
    },
    renameSync(source, destination) {
      events.push(['rename', source, destination]);
      finalContent = 'hw.keyboard=yes\n';
    },
  };

  assert.equal(avd.enableAvdKeyboard('Pixel_8', { configPath, fileSystem }), true);
  assert.equal(path.dirname(temporaryPath), path.dirname(configPath));
  assert.match(path.basename(temporaryPath), /^\.config\.ini\..+\.tmp$/);
  assert.deepEqual(events.map(([operation]) => operation), ['read', 'stat', 'write', 'rename']);
  assert.deepEqual(events.at(-1), ['rename', temporaryPath, configPath]);
  assert.equal(finalContent, 'hw.keyboard=yes\n');
});

test('enableAvdKeyboard removes its temp file when atomic rename fails', () => {
  const configPath = '/virtual/Pixel_8.avd/config.ini';
  let temporaryPath;
  let removedPath;
  const fileSystem = {
    readFileSync() { return 'hw.keyboard=no\n'; },
    statSync() { return { mode: 0o100644 }; },
    writeFileSync(candidate) { temporaryPath = candidate; },
    renameSync() {
      const error = new Error('rename denied');
      error.code = 'EACCES';
      throw error;
    },
    existsSync(candidate) { return candidate === temporaryPath; },
    unlinkSync(candidate) { removedPath = candidate; },
  };

  assert.throws(
    () => avd.enableAvdKeyboard('Pixel_8', { configPath, fileSystem }),
    (error) => error instanceof SdkError && /rename denied/.test(error.message)
  );
  assert.equal(removedPath, temporaryPath);
});

test('createAvd enables keyboard after avdmanager creates config.ini', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-create-avd-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.ini');

  avd.createAvd(
    { name: 'Pixel_8', systemImagePackage: 'system-images;android-35;google_apis;arm64-v8a', deviceId: 'pixel_8' },
    {
      configPath,
      execute(command, args, options) {
        assert.equal(command, 'avdmanager');
        assert.deepEqual(args, [
          'create', 'avd', '-n', 'Pixel_8', '-k', 'system-images;android-35;google_apis;arm64-v8a', '-d', 'pixel_8',
        ]);
        assert.deepEqual(options, { input: '\n' });
        fs.writeFileSync(configPath, 'hw.keyboard=no\nhw.ramSize=2048\n');
      },
    }
  );

  assert.equal(fs.readFileSync(configPath, 'utf8'), 'hw.keyboard=yes\nhw.ramSize=2048\n');
});

test('createAvd marks a keyboard failure as partial success with recovery details', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-partial-avd-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.ini');

  assert.throws(
    () => avd.createAvd(
      { name: 'Pixel_8', systemImagePackage: 'system-images;android-35;google_apis;arm64-v8a' },
      { configPath, execute() {} }
    ),
    (error) => error instanceof SdkError
      && error.avdCreated === true
      && error.cause instanceof SdkError
      && /AVD "Pixel_8" создан/.test(error.message)
      && error.message.includes(configPath)
      && /hw\.keyboard=yes/.test(error.message)
  );
});
