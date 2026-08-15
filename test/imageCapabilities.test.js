import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySystemImage,
  formatMitmCapabilityLabel,
  sortImagesForMitm,
} from '../src/imageCapabilities.js';

test('classifySystemImage uses the package tag segment', () => {
  assert.equal(
    classifySystemImage('system-images;android-34;google_apis_playstore;arm64-v8a'),
    'magisk-required'
  );

  for (const tag of ['google_apis', 'default', 'aosp_atd', 'google_atd']) {
    assert.equal(classifySystemImage(`system-images;android-34;${tag};arm64-v8a`), 'root-capable');
  }

  assert.equal(
    classifySystemImage('system-images;android-34;vendor_google_apis_playstore;arm64-v8a'),
    'unknown'
  );
});

test('sortImagesForMitm groups capabilities without changing relative order within a group', () => {
  const images = [
    { package: 'system-images;android-35;unknown_vendor;arm64-v8a' },
    { package: 'system-images;android-34;google_apis;arm64-v8a' },
    { package: 'system-images;android-33;google_apis_playstore;arm64-v8a' },
    { package: 'system-images;android-32;default;arm64-v8a' },
    { package: 'system-images;android-31;unknown_other;arm64-v8a' },
  ];

  const sorted = sortImagesForMitm(images);

  assert.deepEqual(sorted.map((image) => image.package), [
    'system-images;android-34;google_apis;arm64-v8a',
    'system-images;android-32;default;arm64-v8a',
    'system-images;android-33;google_apis_playstore;arm64-v8a',
    'system-images;android-35;unknown_vendor;arm64-v8a',
    'system-images;android-31;unknown_other;arm64-v8a',
  ]);
  assert.equal(images[0].package, 'system-images;android-35;unknown_vendor;arm64-v8a');
});

test('formatMitmCapabilityLabel uses Russian labels without emoji', () => {
  assert.equal(
    formatMitmCapabilityLabel('root-capable'),
    'MITM: полностью автоматически'
  );
  assert.equal(formatMitmCapabilityLabel('magisk-required'), 'MITM: требуется Magisk');
  assert.equal(formatMitmCapabilityLabel('unknown'), 'MITM: возможности неизвестны');
});
