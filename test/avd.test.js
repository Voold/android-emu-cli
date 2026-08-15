import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAvdSystemImagePackage } from '../src/avd.js';

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
