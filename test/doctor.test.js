import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDoctorChecks, runDoctor } from '../src/doctor.js';

const completeInput = {
  platform: 'darwin',
  env: { ANDROID_HOME: '/Users/test/Library/Android/sdk' },
  commandExists: () => true,
  readCertificate: () => true,
  isDirectoryReadable: () => true,
  validateBundledCertificates: () => ({ certificates: [], warnings: [] }),
  validateMitmCertificate: () => ({ id: 'mitmproxy' }),
};

function checkById(report, id) {
  return report.checks.find((check) => check.id === id);
}

test('collectDoctorChecks reports a ready macOS host', () => {
  const report = collectDoctorChecks(completeInput);

  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check) => check.status), [
    'ok',
    'ok',
    'ok',
    'ok',
    'ok',
    'ok',
    'ok',
    'ok',
    'ok',
  ]);
});

test('collectDoctorChecks reports invalid bundled certificates and a bounded expiry warning', () => {
  const invalid = collectDoctorChecks({
    ...completeInput,
    validateBundledCertificates: () => { throw new Error('контрольная сумма не совпадает'); },
  });
  assert.equal(checkById(invalid, 'yandex-certificates').status, 'error');
  assert.equal(invalid.ok, false);

  const expiring = collectDoctorChecks({
    ...completeInput,
    validateBundledCertificates: () => ({ warnings: [{ id: 'yandex-intermediate' }] }),
  });
  assert.equal(checkById(expiring, 'yandex-certificates').status, 'warning');
  assert.equal(expiring.ok, true);
});

test('collectDoctorChecks uses the bundled certificate validator by default', () => {
  const report = collectDoctorChecks({
    platform: 'darwin',
    env: { ANDROID_HOME: '/sdk' },
    commandExists: () => true,
    readCertificate: () => true,
    isDirectoryReadable: () => true,
  });

  assert.equal(checkById(report, 'yandex-certificates').status, 'ok');
});

test('collectDoctorChecks reports an actionable failure for a missing command', () => {
  const report = collectDoctorChecks({
    ...completeInput,
    commandExists: (command) => command !== 'emulator',
  });
  const emulator = checkById(report, 'command:emulator');

  assert.equal(report.ok, false);
  assert.equal(emulator.status, 'error');
  assert.match(emulator.message, /emulator/);
  assert.match(emulator.repair, /install\.sh/);
});

test('collectDoctorChecks reports a missing Android SDK environment', () => {
  const report = collectDoctorChecks({ ...completeInput, env: {} });
  const sdkEnvironment = checkById(report, 'android-sdk-env');

  assert.equal(report.ok, false);
  assert.equal(sdkEnvironment.status, 'error');
  assert.match(sdkEnvironment.repair, /ANDROID_HOME/);
});

test('collectDoctorChecks rejects a configured but unreadable Android SDK directory', () => {
  const report = collectDoctorChecks({
    ...completeInput,
    env: { ANDROID_HOME: '/definitely/missing/android-sdk' },
    isDirectoryReadable: () => false,
  });
  const sdkEnvironment = checkById(report, 'android-sdk-env');

  assert.equal(report.ok, false);
  assert.equal(sdkEnvironment.status, 'error');
  assert.match(sdkEnvironment.message, /definitely\/missing\/android-sdk/);
  assert.match(sdkEnvironment.repair, /существующий/);
});

test('collectDoctorChecks reports a missing local mitmproxy CA', () => {
  const report = collectDoctorChecks({
    ...completeInput,
    validateMitmCertificate: () => { throw new Error('mitmproxy-ca-cert.pem не найден'); },
  });
  const mitmCa = checkById(report, 'mitmproxy-ca');

  assert.equal(report.ok, false);
  assert.equal(mitmCa.status, 'error');
  assert.match(mitmCa.message, /mitmproxy/i);
  assert.match(mitmCa.repair, /mitmproxy/);
});

test('collectDoctorChecks rejects a legacy .cer marker when the validated mitmproxy PEM is absent', () => {
  const report = collectDoctorChecks({
    ...completeInput,
    readCertificate: (certificatePath) => certificatePath.endsWith('.cer'),
    validateMitmCertificate: () => { throw new Error('mitmproxy-ca-cert.pem не найден'); },
  });

  const mitmCa = checkById(report, 'mitmproxy-ca');
  assert.equal(mitmCa.status, 'error');
  assert.match(mitmCa.message, /mitmproxy-ca-cert\.pem/);
});

test('collectDoctorChecks rejects non-macOS hosts', () => {
  const report = collectDoctorChecks({ ...completeInput, platform: 'linux' });
  const platform = checkById(report, 'platform');

  assert.equal(report.ok, false);
  assert.equal(platform.status, 'error');
  assert.match(platform.message, /macOS/);
});

test('runDoctor prints repairs and returns a failing exit code', () => {
  const output = [];
  const exitCode = runDoctor({
    ...completeInput,
    commandExists: (command) => command !== 'mitmproxy',
    print: (line) => output.push(line),
  });

  assert.equal(exitCode, 1);
  assert.ok(output.some((line) => line.includes('Команда mitmproxy не найдена')));
  assert.ok(output.some((line) => line.includes('Исправление:')));
});
