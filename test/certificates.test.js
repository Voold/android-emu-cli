import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  androidCertificateName,
  assignAndroidCertificateNames,
  getCertificateExpiryWarnings,
  loadCertificateRegistry,
} from '../src/certificates.js';
import { SdkError } from '../src/errors.js';

const projectCertificateDirectory = path.resolve('certs/yandex');
const ROOT_FINGERPRINT = 'E3:C3:19:26:46:53:6B:C4:FF:AE:6D:D3:43:24:EF:9D:D8:D3:B1:6D:FA:13:A2:4E:13:18:0E:F1:4B:A2:1B:BA';

function makeFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-certificates-test-'));
  const certDir = path.join(directory, 'certs');
  const mitmConfDir = path.join(directory, 'mitmproxy');
  fs.mkdirSync(certDir);
  fs.mkdirSync(mitmConfDir);
  for (const file of ['RootCA.pem', 'IntermediateCA.pem', 'manifest.json']) {
    fs.copyFileSync(path.join(projectCertificateDirectory, file), path.join(certDir, file));
  }
  fs.copyFileSync(path.join(projectCertificateDirectory, 'RootCA.pem'), path.join(mitmConfDir, 'mitmproxy-ca-cert.pem'));
  return { directory, certDir, mitmConfDir };
}

test('loadCertificateRegistry validates bundled assets and returns public descriptors only', () => {
  const fixture = makeFixture();
  try {
    const certificates = loadCertificateRegistry({ certDir: fixture.certDir, mitmConfDir: fixture.mitmConfDir });

    assert.deepEqual(certificates.map((certificate) => certificate.id), ['yandex-root', 'yandex-intermediate', 'mitmproxy']);
    assert.equal(certificates[0].fingerprint, ROOT_FINGERPRINT);
    assert.equal(certificates.every((certificate) => !('privateKey' in certificate) && !('privateKeyPem' in certificate)), true);
    assert.equal(certificates.every((certificate) => certificate.path.endsWith('.pem')), true);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('loadCertificateRegistry rejects a bundled certificate whose bytes differ from the manifest', () => {
  const fixture = makeFixture();
  try {
    fs.appendFileSync(path.join(fixture.certDir, 'RootCA.pem'), '\n');

    assert.throws(
      () => loadCertificateRegistry({ certDir: fixture.certDir, mitmConfDir: fixture.mitmConfDir }),
      (error) => error instanceof SdkError && /контрольная сумма/i.test(error.message) && /RootCA\.pem/.test(error.message)
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('loadCertificateRegistry rejects an unexpected certificate fingerprint and any private key block', () => {
  const fixture = makeFixture();
  try {
    const manifestPath = path.join(fixture.certDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.certificates[0].fingerprintSha256 = Array(32).fill('00').join(':');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    assert.throws(
      () => loadCertificateRegistry({ certDir: fixture.certDir, mitmConfDir: fixture.mitmConfDir }),
      (error) => error instanceof SdkError && /отпечаток/i.test(error.message)
    );

    manifest.certificates[0].fingerprintSha256 = ROOT_FINGERPRINT;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.appendFileSync(path.join(fixture.mitmConfDir, 'mitmproxy-ca-cert.pem'), '\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n');

    assert.throws(
      () => loadCertificateRegistry({ certDir: fixture.certDir, mitmConfDir: fixture.mitmConfDir }),
      (error) => error instanceof SdkError && /закрыт(ый|ого) ключ/.test(error.message)
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('loadCertificateRegistry rejects expired assets and exposes bounded expiry warnings', () => {
  const fixture = makeFixture();
  try {
    assert.throws(
      () => loadCertificateRegistry({
        certDir: fixture.certDir,
        mitmConfDir: fixture.mitmConfDir,
        includeMitm: false,
        now: new Date('2034-01-01T00:00:00Z'),
      }),
      (error) => error instanceof SdkError && /истёк/.test(error.message)
    );

    const certificates = loadCertificateRegistry({
      certDir: fixture.certDir,
      mitmConfDir: fixture.mitmConfDir,
      includeMitm: false,
      now: new Date('2027-01-01T00:00:00Z'),
    });
    const warnings = getCertificateExpiryWarnings(certificates, {
      now: new Date('2027-01-01T00:00:00Z'),
      withinDays: 200,
    });

    assert.deepEqual(warnings.map((warning) => warning.id), ['yandex-intermediate']);
    assert.match(warnings[0].message, /скоро истекает/);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('androidCertificateName uses the Android-compatible OpenSSL subject hash without a shell string', () => {
  const calls = [];
  const filename = androidCertificateName('/tmp/yandex-root.pem', 2, (bin, args) => {
    calls.push([bin, args]);
    return '5a1c3d2e\n';
  });

  assert.equal(filename, '5a1c3d2e.2');
  assert.deepEqual(calls, [['openssl', ['x509', '-subject_hash_old', '-noout', '-in', '/tmp/yandex-root.pem']]]);
});

test('assignAndroidCertificateNames gives colliding hashes deterministic consecutive suffixes', () => {
  const calls = [];
  const named = assignAndroidCertificateNames([
    { id: 'first', path: '/tmp/first.pem' },
    { id: 'second', path: '/tmp/second.pem' },
    { id: 'third', path: '/tmp/third.pem' },
  ], (bin, args) => {
    calls.push([bin, args]);
    return args.at(-1) === '/tmp/third.pem' ? '0badcafe\n' : '5a1c3d2e\n';
  });

  assert.deepEqual(named.map((certificate) => certificate.androidName), ['5a1c3d2e.0', '5a1c3d2e.1', '0badcafe.0']);
  assert.equal(calls.every(([bin, args]) => bin === 'openssl' && Array.isArray(args)), true);
});

test('loadCertificateRegistry rejects malformed manifest shape before accepting assets', () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(path.join(fixture.certDir, 'manifest.json'), JSON.stringify({ version: 1, certificates: [] }));

    assert.throws(
      () => loadCertificateRegistry({ certDir: fixture.certDir, mitmConfDir: fixture.mitmConfDir }),
      (error) => error instanceof SdkError && /manifest/.test(error.message)
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
