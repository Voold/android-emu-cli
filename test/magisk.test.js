import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  buildMagiskManualInstructions,
  buildMagiskModule,
  determineActiveCertificateStore,
  getMagiskModuleState,
  prepareMagiskModule,
  pushMagiskModule,
  resolveMagiskCertificateNames,
} from '../src/magisk.js';
import { SdkError } from '../src/errors.js';

const rootPath = path.resolve('certs/yandex/RootCA.pem');
const rootBytes = fs.readFileSync(rootPath);
const rootFingerprint = new X509Certificate(rootBytes).fingerprint256.toUpperCase();
const intermediateBytes = fs.readFileSync(path.resolve('certs/yandex/IntermediateCA.pem'));

function makeCertificate(overrides = {}) {
  return {
    id: 'yandex-root',
    path: rootPath,
    fingerprint: rootFingerprint,
    androidName: '5a1c3d2e.0',
    ...overrides,
  };
}

function makeDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-magisk-test-'));
}

test('buildMagiskModule stages only validated public CAs at the standard Magisk paths and modes', async () => {
  const directory = makeDirectory();
  const outputPath = path.join(directory, 'module.zip');
  let snapshot;
  try {
    const result = await buildMagiskModule({
      certificates: [makeCertificate()],
      outputPath,
      archive: async ({ cwd, outputPath: archiveOutputPath, entries }) => {
        snapshot = {
          entries,
          moduleProp: fs.readFileSync(path.join(cwd, 'module.prop'), 'utf8'),
          certificate: fs.readFileSync(path.join(cwd, 'system/etc/security/cacerts/5a1c3d2e.0')),
          moduleMode: fs.statSync(path.join(cwd, 'module.prop')).mode & 0o777,
          certificateMode: fs.statSync(path.join(cwd, 'system/etc/security/cacerts/5a1c3d2e.0')).mode & 0o777,
          postFsDataMode: fs.statSync(path.join(cwd, 'post-fs-data.sh')).mode & 0o777,
          serviceMode: fs.statSync(path.join(cwd, 'service.sh')).mode & 0o777,
        };
        fs.writeFileSync(archiveOutputPath, 'archive');
      },
    });

    assert.equal(result.outputPath, outputPath);
    assert.deepEqual(snapshot.entries, ['module.prop', 'post-fs-data.sh', 'service.sh', 'system']);
    assert.match(snapshot.moduleProp, /^id=android_emu_ca$/m);
    assert.equal(snapshot.moduleMode, 0o644);
    assert.equal(snapshot.certificateMode, 0o644);
    assert.equal(snapshot.postFsDataMode, 0o755);
    assert.equal(snapshot.serviceMode, 0o755);
    assert.deepEqual(snapshot.certificate, rootBytes);
    assert.equal(snapshot.moduleProp.includes('PRIVATE KEY'), false);
    assert.equal(fs.existsSync(result.stagingPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('buildMagiskModule creates an inspectable ZIP with exact entries, bytes, and Unix modes when zip tools exist', { skip: spawnSync('zip', ['-v']).status !== 0 || spawnSync('unzip', ['-v']).status !== 0 }, async () => {
  const directory = makeDirectory();
  const outputPath = path.join(directory, 'module.zip');
  try {
    await buildMagiskModule({ certificates: [makeCertificate()], outputPath });
    const listing = spawnSync('unzip', ['-Z', '-1', outputPath], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trim().split('\n'), [
      'module.prop', 'post-fs-data.sh', 'service.sh', 'system/', 'system/etc/', 'system/etc/security/',
      'system/etc/security/cacerts/', 'system/etc/security/cacerts/5a1c3d2e.0',
    ]);
    const certificate = spawnSync('unzip', ['-p', outputPath, 'system/etc/security/cacerts/5a1c3d2e.0'], { encoding: null });
    assert.equal(certificate.status, 0, Buffer.from(certificate.stderr || '').toString('utf8'));
    assert.deepEqual(certificate.stdout, rootBytes);
    const metadata = spawnSync('unzip', ['-Z', '-v', outputPath], { encoding: 'utf8' });
    assert.equal(metadata.status, 0, metadata.stderr);
    assert.match(metadata.stdout, /module\.prop[\s\S]*?Unix file attributes \(100644 octal\)/);
    assert.match(metadata.stdout, /post-fs-data\.sh[\s\S]*?Unix file attributes \(100755 octal\)/);
    assert.match(metadata.stdout, /service\.sh[\s\S]*?Unix file attributes \(100755 octal\)/);
    assert.match(metadata.stdout, /cacerts\/5a1c3d2e\.0[\s\S]*?Unix file attributes \(100644 octal\)/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Magisk APEX scripts are LF executable, syntactically valid, and mount a complete bounded CA merge', () => {
  const scriptPaths = [
    path.resolve('assets/magisk/post-fs-data.sh'),
    path.resolve('assets/magisk/service.sh'),
  ];
  for (const scriptPath of scriptPaths) {
    const source = fs.readFileSync(scriptPath, 'utf8');
    assert.equal(source.includes('\r'), false, `${scriptPath} must use LF`);
    assert.match(source, /^#!\/system\/bin\/sh\n/);
    assert.match(source, /MODDIR=\$\{0%\/\*\}/);
    assert.equal(/PRIVATE KEY|\b(curl|wget|ftp)\b|\beval\b/i.test(source), false);
    const syntax = spawnSync('sh', ['-n', scriptPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }

  const postFsData = fs.readFileSync(scriptPaths[0], 'utf8');
  const service = fs.readFileSync(scriptPaths[1], 'utf8');
  assert.match(postFsData, /APEX_CA_DIR=\/apex\/com\.android\.conscrypt\/cacerts/);
  assert.match(postFsData, /MODULE_CA_DIR="\$MODDIR\/system\/etc\/security\/cacerts"/);
  assert.match(postFsData, /MERGED_CA_DIR="\$MODDIR\/apex-cacerts"/);
  assert.match(postFsData, /cp -fp "\$source" "\$MERGED_CA_DIR\/\$name"/);
  assert.match(postFsData, /mount -o bind "\$MERGED_CA_DIR" "\$APEX_CA_DIR"/);
  assert.match(postFsData, /chown 0:0/);
  assert.match(postFsData, /chmod 0644/);
  assert.match(postFsData, /case "\$suffix" in\n\s*\*\[!0-9\]\*\|''\) return 1/);
  assert.match(postFsData, /chcon u:object_r:system_file:s0 "\$MERGED_CA_DIR" "\$MERGED_CA_DIR"\/\*/);
  assert.match(postFsData, /cmp -s "\$source" "\$target"/);
  assert.match(postFsData, /module CA filename collides/);
  assert.match(postFsData, /getprop ro\.build\.version\.sdk/);
  assert.match(postFsData, /getprop system\.certs\.enabled/);
  assert.match(postFsData, /"\$SDK_VERSION" -lt 34/);
  assert.match(postFsData, /true\) return 1/);
  assert.match(service, /nsenter -t "\$pid" -m -- mount -o bind "\$MERGED_CA_DIR" "\$APEX_CA_DIR"/);
  assert.match(service, /bind_for_zygote zygote/);
  assert.match(service, /bind_for_zygote zygote64/);
  assert.match(service, /"\$MODDIR\/post-fs-data\.sh" \|\| \{/);
  assert.match(service, /ZYGOTE_FOUND=0/);
  assert.match(service, /ZYGOTE_BOUND=0/);
  assert.match(service, /if \[ "\$ZYGOTE_FOUND" -gt 0 \] && \[ "\$ZYGOTE_BOUND" -eq "\$ZYGOTE_FOUND" \]; then/);
  assert.match(service, /MAX_ZYGOTE_ATTEMPTS=[1-9][0-9]*/);
  assert.match(service, /ZYGOTE_RETRY_SECONDS=[1-9][0-9]*/);
  assert.match(service, /while \[ "\$attempt" -le "\$MAX_ZYGOTE_ATTEMPTS" \]/);
  assert.match(service, /ZYGOTE_FOUND=0\n\s*ZYGOTE_BOUND=0/);
  assert.match(service, /\[ "\$ZYGOTE_BOUND" -eq "\$ZYGOTE_FOUND" \]/);
  assert.match(service, /sleep "\$ZYGOTE_RETRY_SECONDS"/);
  assert.match(service, /timed out waiting for zygote namespace bind/);
});

test('determineActiveCertificateStore reproduces the bounded AOSP Conscrypt predicate', () => {
  assert.equal(determineActiveCertificateStore({ sdkVersion: '33', systemCertsEnabled: '', apexNames: ['5a1c3d2e.0'] }), 'system');
  assert.equal(determineActiveCertificateStore({ sdkVersion: '34', systemCertsEnabled: 'true', apexNames: ['5a1c3d2e.0'] }), 'system');
  assert.equal(determineActiveCertificateStore({ sdkVersion: '34', systemCertsEnabled: 'false', apexNames: ['5a1c3d2e.0'] }), 'apex');
  assert.equal(determineActiveCertificateStore({ sdkVersion: '34', systemCertsEnabled: '', apexNames: ['5a1c3d2e.0'] }), 'apex');
  assert.equal(determineActiveCertificateStore({ sdkVersion: '34', systemCertsEnabled: '', apexNames: [] }), 'system');
  assert.throws(() => determineActiveCertificateStore({ sdkVersion: '34x', systemCertsEnabled: '', apexNames: [] }), SdkError);
  assert.throws(() => determineActiveCertificateStore({ sdkVersion: '34', systemCertsEnabled: 'unexpected', apexNames: [] }), SdkError);
});

test('resolveMagiskCertificateNames keeps an unrelated APEX hash suffix and chooses the next union-free name', async () => {
  const names = await resolveMagiskCertificateNames(
    { serial: 'emulator-5554', certificates: [makeCertificate()] },
    {
      listCertificateNames: async ({ directory }) => directory.includes('/apex/') ? ['5a1c3d2e.0'] : [],
      readCertificate: async () => intermediateBytes,
      getAndroidCertificateHash: async () => '5a1c3d2e',
      getDeviceProperty: async ({ key }) => key === 'ro.build.version.sdk' ? '34' : 'false',
    }
  );
  assert.deepEqual(names.map(({ androidName, needsInstall }) => ({ androidName, needsInstall })), [{ androidName: '5a1c3d2e.1', needsInstall: true }]);
});

test('resolveMagiskCertificateNames treats an exact active APEX certificate as current and tolerates an absent pre-14 APEX directory', async () => {
  const activeApex = await resolveMagiskCertificateNames(
    { serial: 'emulator-5554', certificates: [makeCertificate()] },
    {
      listCertificateNames: async ({ directory }) => directory.includes('/apex/') ? ['5a1c3d2e.0'] : [],
      readCertificate: async () => rootBytes,
      getAndroidCertificateHash: async () => '5a1c3d2e',
      getDeviceProperty: async ({ key }) => key === 'ro.build.version.sdk' ? '34' : 'false',
    }
  );
  assert.deepEqual(activeApex.map(({ androidName, needsInstall }) => ({ androidName, needsInstall })), [{ androidName: '5a1c3d2e.0', needsInstall: false }]);

  const pre14 = await resolveMagiskCertificateNames(
    { serial: 'emulator-5554', certificates: [makeCertificate()] },
    {
      listCertificateNames: async ({ directory }) => {
        if (directory.includes('/apex/')) throw new Error('No such file or directory');
        return ['5a1c3d2e.0'];
      },
      readCertificate: async () => rootBytes,
      getAndroidCertificateHash: async () => '5a1c3d2e',
      getDeviceProperty: async ({ key }) => key === 'ro.build.version.sdk' ? '33' : '',
    }
  );
  assert.deepEqual(pre14.map(({ androidName, needsInstall }) => ({ androidName, needsInstall })), [{ androidName: '5a1c3d2e.0', needsInstall: false }]);
});

test('resolveMagiskCertificateNames queries AOSP active-store properties and does not reuse an APEX-only CA below API 34', async () => {
  const calls = [];
  const resolved = await resolveMagiskCertificateNames(
    { serial: 'emulator-5554', certificates: [makeCertificate()] },
    {
      listCertificateNames: async ({ directory }) => directory.includes('/apex/') ? ['5a1c3d2e.0'] : [],
      readCertificate: async () => rootBytes,
      getAndroidCertificateHash: async () => '5a1c3d2e',
      getDeviceProperty: async ({ key }) => {
        calls.push(key);
        return key === 'ro.build.version.sdk' ? '33' : '';
      },
    }
  );
  assert.deepEqual(calls, ['ro.build.version.sdk', 'system.certs.enabled']);
  assert.deepEqual(resolved.map(({ androidName, needsInstall }) => ({ androidName, needsInstall })), [{ androidName: '5a1c3d2e.1', needsInstall: true }]);
});

test('prepareMagiskModule skips build and push when the exact CA is already in the active APEX store', async () => {
  const directory = makeDirectory();
  try {
    const result = await prepareMagiskModule(
      {
        serial: 'emulator-5554',
        avdName: 'Play Pixel',
        certificates: [makeCertificate()],
        outputPath: path.join(directory, 'module.zip'),
        statePath: path.join(directory, 'module-state.json'),
      },
      {
        listCertificateNames: async ({ directory: certificateDirectory }) => certificateDirectory.includes('/apex/') ? ['5a1c3d2e.0'] : [],
        readCertificate: async () => rootBytes,
        getAndroidCertificateHash: async () => '5a1c3d2e',
        getDeviceProperty: async ({ key }) => key === 'ro.build.version.sdk' ? '34' : 'false',
        buildModule: async () => { throw new Error('must not rebuild current module'); },
        pushModule: async () => { throw new Error('must not push current module'); },
      }
    );
    assert.deepEqual(result, {
      state: 'current',
      changed: false,
      instructions: buildMagiskManualInstructions(),
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('resolveMagiskCertificateNames does not hide non-absence APEX inventory errors', async () => {
  await assert.rejects(
    () => resolveMagiskCertificateNames(
      { serial: 'emulator-5554', certificates: [makeCertificate()] },
      {
        listCertificateNames: async ({ directory }) => {
          if (directory.includes('/apex/')) throw new Error('adb transport offline');
          return [];
        },
        getDeviceProperty: async ({ key }) => key === 'ro.build.version.sdk' ? '34' : 'false',
      }
    ),
    (error) => error instanceof SdkError && /transport offline/.test(error.message)
  );
});

test('prepareMagiskModule regenerates when system has the expected CA but the active APEX has a different CA at that name', async () => {
  const directory = makeDirectory();
  const outputPath = path.join(directory, 'module.zip');
  const statePath = path.join(directory, 'module-state.json');
  const calls = [];
  try {
    const result = await prepareMagiskModule(
      { serial: 'emulator-5554', avdName: 'Play Pixel', certificates: [makeCertificate()], outputPath, statePath },
      {
        listCertificateNames: async ({ directory: certificateDirectory }) => certificateDirectory.includes('/apex/') ? ['5a1c3d2e.0'] : ['5a1c3d2e.0'],
        readCertificate: async ({ directory }) => directory.includes('/apex/') ? intermediateBytes : rootBytes,
        getAndroidCertificateHash: async () => '5a1c3d2e',
        getDeviceProperty: async ({ key }) => key === 'ro.build.version.sdk' ? '34' : 'false',
        buildModule: async (input) => { calls.push(['build', input.certificates[0].androidName]); return { outputPath: input.outputPath }; },
        pushModule: async (input) => { calls.push(['push', input.modulePath]); return { remotePath: '/storage/emulated/0/Download/android-emu-ca-module.zip' }; },
      }
    );
    assert.equal(result.state, 'missing');
    assert.deepEqual(calls, [['build', '5a1c3d2e.1'], ['push', outputPath]]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('buildMagiskModule rejects unsafe names, duplicates, altered fingerprints, and private keys before archiving', async () => {
  const directory = makeDirectory();
  const outputPath = path.join(directory, 'module.zip');
  let archived = false;
  const archive = async () => { archived = true; };
  const invalidCases = [
    [[makeCertificate({ androidName: '../escape.0' })], /имя Android/i],
    [[makeCertificate({ fingerprint: '00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00' })], /отпечаток/i],
    [[makeCertificate(), makeCertificate({ id: 'copy' })], /дубликат/i],
  ];
  try {
    for (const [certificates, matcher] of invalidCases) {
      await assert.rejects(
        () => buildMagiskModule({ certificates, outputPath, archive }),
        (error) => error instanceof SdkError && matcher.test(error.message)
      );
    }

    const privatePath = path.join(directory, 'private.pem');
    fs.writeFileSync(privatePath, `${rootBytes.toString('utf8')}\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n`);
    await assert.rejects(
      () => buildMagiskModule({ certificates: [makeCertificate({ path: privatePath })], outputPath, archive }),
      (error) => error instanceof SdkError && /закрыт(ый|ого) ключ/i.test(error.message)
    );
    assert.equal(archived, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('buildMagiskModule removes the staging directory and keeps the archive error cause', async () => {
  const directory = makeDirectory();
  let stagedPath;
  try {
    await assert.rejects(
      () => buildMagiskModule({
        certificates: [makeCertificate()],
        outputPath: path.join(directory, 'module.zip'),
        archive: async ({ cwd }) => {
          stagedPath = cwd;
          throw new Error('zip unavailable');
        },
      }),
      (error) => error instanceof SdkError && /архив/i.test(error.message) && /zip unavailable/.test(error.message) && error.cause?.message === 'zip unavailable'
    );
    assert.equal(fs.existsSync(stagedPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('pushMagiskModule uses argv and the fixed Download destination without installing Magisk', async () => {
  const directory = makeDirectory();
  const modulePath = path.join(directory, 'module.zip');
  fs.writeFileSync(modulePath, 'archive');
  const calls = [];
  try {
    const result = await pushMagiskModule(
      { serial: 'emulator-5554', modulePath },
      { run: async (bin, args) => { calls.push([bin, args]); } }
    );
    assert.deepEqual(calls, [[
      'adb',
      ['-s', 'emulator-5554', 'push', modulePath, '/storage/emulated/0/Download/android-emu-ca-module.zip'],
    ]]);
    assert.equal(result.remotePath, '/storage/emulated/0/Download/android-emu-ca-module.zip');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('getMagiskModuleState differentiates absent, partial or changed, and exact certificate sets', () => {
  const expected = [rootFingerprint, 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'];
  assert.equal(getMagiskModuleState(expected, []), 'missing');
  assert.equal(getMagiskModuleState(expected, [rootFingerprint]), 'stale');
  assert.equal(getMagiskModuleState(expected, expected.map((value) => value.toLowerCase()).reverse()), 'current');
  assert.throws(() => getMagiskModuleState(expected, ['not-a-fingerprint']), (error) => error instanceof SdkError && /отпечатк/i.test(error.message));
});

test('prepareMagiskModule skips current certificates and regenerates and pushes missing or stale sets', async () => {
  const directory = makeDirectory();
  const outputPath = path.join(directory, 'module.zip');
  const statePath = path.join(directory, 'module-state.json');
  const calls = [];
  const baseDeps = {
    resolveMagiskCertificateNames: async ({ certificates }) => certificates.map((certificate) => ({ ...certificate, needsInstall: false })),
    buildModule: async () => { throw new Error('must not build current module'); },
    pushModule: async () => { throw new Error('must not push current module'); },
  };
  try {
    const current = await prepareMagiskModule(
      { serial: 'emulator-5554', avdName: 'Play Pixel', certificates: [makeCertificate()], outputPath, statePath },
      baseDeps
    );
    assert.equal(current.state, 'current');
    assert.equal(current.changed, false);

    const regenerate = await prepareMagiskModule(
      { serial: 'emulator-5554', avdName: 'Play Pixel', certificates: [makeCertificate()], outputPath, statePath },
      {
        resolveMagiskCertificateNames: async ({ certificates }) => certificates.map((certificate) => ({ ...certificate, needsInstall: true })),
        buildModule: async (input) => { calls.push(['build', input]); return { outputPath: input.outputPath }; },
        pushModule: async (input) => { calls.push(['push', input]); return { remotePath: '/storage/emulated/0/Download/android-emu-ca-module.zip' }; },
      }
    );
    assert.equal(regenerate.state, 'missing');
    assert.equal(regenerate.changed, true);
    assert.deepEqual(calls.map(([name]) => name), ['build', 'push']);
    assert.match(regenerate.instructions.steps.join('\n'), /Install from storage/);
    assert.match(regenerate.instructions.notice, /не устанавливает Magisk/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('prepareMagiskModule treats a changed recorded CA set as stale and replaces the pushed ZIP', async () => {
  const directory = makeDirectory();
  const outputPath = path.join(directory, 'module.zip');
  const statePath = path.join(directory, 'module-state.json');
  const oldFingerprint = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
  fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, fingerprints: [oldFingerprint] })}\n`);
  const calls = [];
  try {
    const result = await prepareMagiskModule(
      { serial: 'emulator-5554', avdName: 'Play Pixel', certificates: [makeCertificate()], outputPath, statePath },
      {
        resolveMagiskCertificateNames: async ({ certificates }) => certificates.map((certificate) => ({ ...certificate, needsInstall: false })),
        buildModule: async (input) => { calls.push(['build', input.outputPath]); return { outputPath: input.outputPath }; },
        pushModule: async (input) => { calls.push(['push', input.modulePath]); return { remotePath: '/storage/emulated/0/Download/android-emu-ca-module.zip' }; },
      }
    );
    assert.equal(result.state, 'stale');
    assert.deepEqual(calls.map(([name]) => name), ['build', 'push']);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).fingerprints, [rootFingerprint]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('buildMagiskManualInstructions gives the one-time Russian Magisk UI path and pinning boundary', () => {
  const instructions = buildMagiskManualInstructions('/storage/emulated/0/Download/android-emu-ca-module.zip');
  assert.deepEqual(instructions.steps, [
    'Откройте Magisk → Modules → Install from storage.',
    'Выберите файл Download/android-emu-ca-module.zip.',
    'После установки перезагрузите эмулятор.',
    'Повторно запустите android-emu, чтобы проверить отпечатки сертификатов.',
  ]);
  assert.match(instructions.notice, /не устанавливает Magisk.*не получает root.*не обходит certificate pinning/i);
});
