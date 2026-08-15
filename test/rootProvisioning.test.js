import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SdkError } from '../src/errors.js';
import {
  buildRootProvisioningPlan,
  parseRemountResult,
  parseVerificationResult,
  provisionRootCertificates,
  waitForDeviceBoot,
} from '../src/rootProvisioning.js';
import * as rootProvisioning from '../src/rootProvisioning.js';

const ROOT_PATH = path.resolve('certs/yandex/RootCA.pem');
const ROOT_FINGERPRINT = 'E3:C3:19:26:46:53:6B:C4:FF:AE:6D:D3:43:24:EF:9D:D8:D3:B1:6D:FA:13:A2:4E:13:18:0E:F1:4B:A2:1B:BA';
const ROOT_BYTES = fs.readFileSync(ROOT_PATH);
const certificate = Object.freeze({
  id: 'yandex-root',
  path: ROOT_PATH,
  fingerprint: ROOT_FINGERPRINT,
  androidName: '5a1c3d2e.0',
});

const systemStoreDependencies = Object.freeze({
  getDeviceProperty: async ({ key }) => key === 'ro.build.version.sdk' ? '33' : '',
  listApexCertificateNames: async () => [],
});

test('parseApexMountIdentity accepts only two identical device and inode values', () => {
  assert.equal(rootProvisioning.parseApexMountIdentity('253:1048579\n253:1048579\n'), true);
  assert.equal(rootProvisioning.parseApexMountIdentity('253:1048579\n253:1048580\n'), false);
  assert.equal(rootProvisioning.parseApexMountIdentity('253:1048579\n'), false);
  assert.equal(rootProvisioning.parseApexMountIdentity('253:1048579 extra\n253:1048579'), false);
  assert.equal(rootProvisioning.parseApexMountIdentity('not-a-stat-value\nnot-a-stat-value'), false);
});

test('buildRootProvisioningPlan orders root, reboot gate, remount, install and final verification with argv arrays', () => {
  const plan = buildRootProvisioningPlan({
    serial: 'emulator-5554',
    certificates: [certificate],
    deviceState: {
      certificatesToInstall: [certificate],
      verificationDisabled: false,
      verificationRequiresReboot: true,
      remountRequiresReboot: false,
    },
  });

  assert.deepEqual(plan.map((step) => step.stage), [
    'adb-root', 'wait-after-adb-root', 'disable-verification', 'reboot-after-verification', 'wait-after-verification',
    'adb-root-after-verification-reboot', 'wait-after-adb-root-after-verification-reboot',
    'remount', 'install:yandex-root', 'chmod:yandex-root', 'reboot-after-install',
    'wait-after-install', 'verify-final',
  ]);
  assert.deepEqual(plan.find((step) => step.stage === 'install:yandex-root').argv, [
    'adb', '-s', 'emulator-5554', 'push', ROOT_PATH, '/system/etc/security/cacerts/5a1c3d2e.0',
  ]);
  assert.equal(plan.every((step) => !('command' in step)), true);
});

test('provisionRootCertificates waits and reacquires root after a reboot before remounting', async () => {
  const calls = [];
  let installed = false;
  await provisionRootCertificates(
    { serial: 'emulator-5554', certificates: [certificate] },
    {
      ...systemStoreDependencies,
      run: async (bin, args) => {
        calls.push([bin, args]);
        if (args.includes('disable-verification')) return 'Successfully disabled verification. Reboot the device for changes to take effect.';
        if (args.at(-1) === 'remount') return 'remount succeeded';
        if (args.at(-1) === 'reboot') installed = true;
        return '';
      },
      waitForBoot: async (serial) => calls.push(['waitForBoot', [serial]]),
      listSystemCertificateNames: async () => [],
      getAndroidCertificateHash: async () => '5a1c3d2e',
      readSystemCertificate: async () => installed ? ROOT_BYTES : null,
    }
  );

  assert.deepEqual(calls.map(([bin, args]) => [bin, args.at(-1)]), [
    ['adb', 'root'], ['waitForBoot', 'emulator-5554'], ['adb', 'disable-verification'],
    ['adb', 'reboot'], ['waitForBoot', 'emulator-5554'], ['adb', 'root'],
    ['waitForBoot', 'emulator-5554'], ['adb', 'remount'],
    ['adb', '/system/etc/security/cacerts/5a1c3d2e.0'], ['adb', '/system/etc/security/cacerts/5a1c3d2e.0'],
    ['adb', 'reboot'], ['waitForBoot', 'emulator-5554'],
  ]);
});

test('provisionRootCertificates records a bounded avbctl unsupported warning and still attempts remount', async () => {
  const calls = [];
  let installed = false;
  const result = await provisionRootCertificates(
    { serial: 'emulator-5554', certificates: [certificate] },
    {
      ...systemStoreDependencies,
      run: async (bin, args) => {
        calls.push([bin, args]);
        if (args.includes('disable-verification')) throw new Error('avbctl: not found');
        if (args.at(-1) === 'remount') return 'remount succeeded';
        if (args.at(-1) === 'reboot') installed = true;
        return '';
      },
      waitForBoot: async () => {},
      listSystemCertificateNames: async () => [],
      getAndroidCertificateHash: async () => '5a1c3d2e',
      readSystemCertificate: async () => installed ? ROOT_BYTES : null,
    }
  );

  assert.equal(calls.some(([, args]) => args.at(-1) === 'remount'), true);
  assert.match(result.warnings[0].message, /avbctl/);
});

test('provisionRootCertificates preserves an occupied hash.0 and installs a different certificate at hash.1', async () => {
  const otherCertificate = fs.readFileSync(path.resolve('certs/yandex/IntermediateCA.pem'));
  const calls = [];
  let installed = false;
  const result = await provisionRootCertificates(
    { serial: 'emulator-5554', certificates: [{ ...certificate, androidName: '5a1c3d2e.0' }] },
    {
      ...systemStoreDependencies,
      run: async (bin, args) => {
        calls.push([bin, args]);
        if (args.includes('disable-verification')) return 'Verification is already disabled.';
        if (args.at(-1) === 'remount') return 'remount succeeded';
        if (args.at(-1) === 'reboot') installed = true;
        return '';
      },
      waitForBoot: async () => {},
      listSystemCertificateNames: async () => ['5a1c3d2e.0'],
      getAndroidCertificateHash: async () => '5a1c3d2e',
      readSystemCertificate: async ({ path: certificatePath }) => {
        if (certificatePath.endsWith('.0')) return otherCertificate;
        return installed ? ROOT_BYTES : null;
      },
    }
  );

  assert.deepEqual(result.installed, ['yandex-root']);
  const pushedTarget = calls.find(([, args]) => args.includes('push'))[1].at(-1);
  assert.equal(pushedTarget, '/system/etc/security/cacerts/5a1c3d2e.1');
  assert.equal(calls.some(([, args]) => args.includes('push') && args.at(-1).endsWith('.0')), false);
});

test('buildRootProvisioningPlan skips mutation when every expected certificate is already correct', () => {
  assert.deepEqual(buildRootProvisioningPlan({
    serial: 'emulator-5554',
    certificates: [certificate],
    deviceState: { certificatesToInstall: [] },
  }), [{ stage: 'verify-final', kind: 'verify' }]);
});

test('waitForDeviceBoot uses adb wait-for-device and bounded boot polling through injected dependencies', async () => {
  const calls = [];
  let now = 0;
  let polls = 0;
  await waitForDeviceBoot('emulator-5554', {
    run: async (bin, args) => {
      calls.push([bin, args]);
      if (args.at(-1) === 'sys.boot_completed') return polls++ === 0 ? '0' : '1';
      return '';
    },
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    timeoutMs: 100,
    intervalMs: 40,
  });

  assert.deepEqual(calls, [
    ['adb', ['-s', 'emulator-5554', 'wait-for-device']],
    ['adb', ['-s', 'emulator-5554', 'shell', 'getprop', 'sys.boot_completed']],
    ['adb', ['-s', 'emulator-5554', 'shell', 'getprop', 'sys.boot_completed']],
  ]);
  assert.equal(now, 40);
});

test('output parsers model known Android reboot gates and reject ambiguous output', () => {
  assert.deepEqual(parseVerificationResult('Successfully disabled verification. Reboot the device for changes to take effect.'), { requiresReboot: true });
  assert.deepEqual(parseVerificationResult('Verification is already disabled.'), { requiresReboot: false });
  assert.deepEqual(parseRemountResult('remount succeeded'), { requiresReboot: false });
  assert.deepEqual(parseRemountResult('remount succeeded; reboot required'), { requiresReboot: true });
  assert.deepEqual(parseRemountResult('Verity disabled; overlayfs enabled. Now reboot your device for settings to take effect'), { requiresReboot: true });
  assert.deepEqual(parseRemountResult('remount succeeded.. now reboot device for settings refresh'), { requiresReboot: true });
  assert.deepEqual(parseRemountResult('Using overlayfs for /system\nUsing overlayfs for /vendor\nNow reboot your device for settings to take effect'), { requiresReboot: true });

  assert.throws(() => parseVerificationResult('perhaps changed'), (error) => error instanceof SdkError && /avbctl/.test(error.message));
  assert.throws(() => parseRemountResult('something else'), (error) => error instanceof SdkError && /remount/.test(error.message));
  assert.throws(() => parseRemountResult('reboot'), (error) => error instanceof SdkError && /remount/.test(error.message));
  assert.throws(() => parseRemountResult('remount failed'), (error) => error instanceof SdkError && /remount/.test(error.message));
  assert.throws(() => parseRemountResult('remount succeeded\nsetup failure\nNow reboot your device for settings to take effect'), (error) => error instanceof SdkError && /remount/.test(error.message));
});

test('provisionRootCertificates installs only a missing certificate, follows reboot gates, and verifies the final fingerprint', async () => {
  const calls = [];
  let readyForVerification = false;
  const result = await provisionRootCertificates(
    { serial: 'emulator-5554', certificates: [certificate] },
    {
      ...systemStoreDependencies,
      run: async (bin, args) => {
        calls.push([bin, args]);
        if (args.includes('disable-verification')) return 'Successfully disabled verification. Reboot the device for changes to take effect.';
        if (args.at(-1) === 'remount') return 'remount succeeded';
        if (args.at(-1) === 'reboot') readyForVerification = true;
        return '';
      },
      waitForBoot: async (serial) => calls.push(['waitForBoot', [serial]]),
      listSystemCertificateNames: async () => [],
      getAndroidCertificateHash: async () => '5a1c3d2e',
      readSystemCertificate: async () => readyForVerification ? ROOT_BYTES : null,
    }
  );

  assert.deepEqual(result, { changed: true, installed: ['yandex-root'] });
  assert.deepEqual(calls.map(([bin, args]) => [bin, args.includes('chmod') ? args.at(-2) : args.at(-1)]), [
    ['adb', 'root'],
    ['waitForBoot', 'emulator-5554'],
    ['adb', 'disable-verification'],
    ['adb', 'reboot'],
    ['waitForBoot', 'emulator-5554'],
    ['adb', 'root'],
    ['waitForBoot', 'emulator-5554'],
    ['adb', 'remount'],
    ['adb', '/system/etc/security/cacerts/5a1c3d2e.0'],
    ['adb', '0644'],
    ['adb', 'reboot'],
    ['waitForBoot', 'emulator-5554'],
  ]);
});

test('provisionRootCertificates is idempotent when the device already has the exact certificate fingerprint', async () => {
  let commands = 0;
  const result = await provisionRootCertificates(
    { serial: 'emulator-5554', certificates: [certificate] },
    {
      ...systemStoreDependencies,
      run: async () => { commands += 1; return ''; },
      waitForBoot: async () => { throw new Error('must not reboot'); },
      listSystemCertificateNames: async () => [],
      getAndroidCertificateHash: async () => '5a1c3d2e',
      readSystemCertificate: async () => ROOT_BYTES,
    }
  );

  assert.deepEqual(result, { changed: false, installed: [] });
  assert.equal(commands, 0);
});

test('provisionRootCertificates keeps the failing stage and original command failure visible', async () => {
  await assert.rejects(
    () => provisionRootCertificates(
      { serial: 'emulator-5554', certificates: [certificate] },
      {
        ...systemStoreDependencies,
        run: async (_bin, args) => {
          if (args.at(-1) === 'remount') throw new Error('transport is offline');
          if (args.includes('disable-verification')) return 'Verification is already disabled.';
          return '';
        },
        waitForBoot: async () => {},
        readSystemCertificate: async () => null,
      }
    ),
    (error) => error instanceof SdkError && /Этап "remount"/.test(error.message) && /transport is offline/.test(error.message) && /Повторите запуск/.test(error.message)
  );
});

test('provisionRootCertificates fails closed unless active Android 14 APEX CA store and zygote mounts are verified', async () => {
  const calls = [];
  const result = await provisionRootCertificates(
    { serial: 'emulator-5554', certificates: [certificate] },
    {
      getDeviceProperty: async ({ key }) => key === 'ro.build.version.sdk' ? '34' : 'false',
      listSystemCertificateNames: async () => [],
      listApexCertificateNames: async () => ['12345678.0'],
      readStoreCertificate: async () => otherCertificateBytes(),
      getAndroidCertificateHash: async () => '5a1c3d2e',
      prepareApexMergedStore: async ({ certificates }) => { calls.push(['prepare', certificates.map((item) => item.androidName)]); },
      pushApexCertificate: async ({ certificate }) => { calls.push(['push', certificate.androidName]); },
      finalizeApexMergedStore: async () => { calls.push(['finalize']); },
      bindApexStore: async () => { calls.push(['bind-host']); },
      findZygotePids: async () => [101, 102],
      bindApexInNamespace: async ({ pid }) => { calls.push(['bind-zygote', pid]); },
      verifyApexMount: async ({ pid }) => { calls.push(['verify', pid]); return true; },
      verifyActiveCertificate: async ({ certificate: item }) => item.id === 'yandex-root',
      run: async (_bin, args) => { calls.push(['run', args.at(-1)]); return ''; },
      waitForBoot: async () => { calls.push(['wait-root']); },
    }
  );
  assert.equal(result.store, 'apex');
  assert.deepEqual(calls, [
    ['run', 'root'], ['wait-root'], ['prepare', ['5a1c3d2e.0']], ['push', '5a1c3d2e.0'], ['finalize'], ['bind-host'],
    ['bind-zygote', 101], ['bind-zygote', 102], ['verify', null], ['verify', 101], ['verify', 102],
  ]);
});

test('active APEX provisioning rejects an unverified zygote namespace instead of reporting success', async () => {
  await assert.rejects(
    () => provisionRootCertificates(
      { serial: 'emulator-5554', certificates: [certificate] },
      {
        getDeviceProperty: async ({ key }) => key === 'ro.build.version.sdk' ? '34' : 'false',
        listSystemCertificateNames: async () => [], listApexCertificateNames: async () => ['12345678.0'],
        readStoreCertificate: async () => otherCertificateBytes(), getAndroidCertificateHash: async () => '5a1c3d2e',
        prepareApexMergedStore: async () => {}, pushApexCertificate: async () => {}, bindApexStore: async () => {},
        finalizeApexMergedStore: async () => {}, run: async () => '', waitForBoot: async () => {},
        findZygotePids: async () => [101], bindApexInNamespace: async () => {},
        verifyApexMount: async ({ pid }) => pid === null,
        verifyActiveCertificate: async () => true,
        zygoteAttempts: 1,
      }
    ),
    /zygote|namespace/i
  );
});

test('active APEX provisioning keeps the last zygote bind error in its bounded failure', async () => {
  await assert.rejects(
    () => provisionRootCertificates(
      { serial: 'emulator-5554', certificates: [certificate] },
      {
        getDeviceProperty: async ({ key }) => key === 'ro.build.version.sdk' ? '34' : 'false',
        listSystemCertificateNames: async () => [], listApexCertificateNames: async () => ['12345678.0'],
        readStoreCertificate: async () => otherCertificateBytes(), getAndroidCertificateHash: async () => '5a1c3d2e',
        prepareApexMergedStore: async () => {}, pushApexCertificate: async () => {}, bindApexStore: async () => {},
        finalizeApexMergedStore: async () => {}, run: async () => '', waitForBoot: async () => {},
        findZygotePids: async () => [101], bindApexInNamespace: async () => { throw new Error('zygote bind failed'); },
        verifyActiveCertificate: async () => true, zygoteAttempts: 1,
      }
    ),
    /zygote bind failed/
  );
});

test('active APEX default mount verification uses stat device and inode in host and zygote namespaces', async () => {
  const commands = [];
  const result = await provisionRootCertificates(
    { serial: 'emulator-5554', certificates: [certificate] },
    {
      run: async (_bin, args) => {
        commands.push(args);
        if (args.includes('getprop')) return args.at(-1) === 'ro.build.version.sdk' ? '34' : 'false';
        if (args.includes('ls')) return args.at(-1).includes('/apex/') ? '12345678.0' : '';
        if (args.includes('stat')) return '253:1048579\n253:1048579\n';
        return '';
      },
      waitForBoot: async () => {}, getAndroidCertificateHash: async () => '5a1c3d2e',
      readStoreCertificate: async () => otherCertificateBytes(), verifyActiveCertificate: async () => true,
      findZygotePids: async () => [101],
    }
  );

  assert.equal(result.store, 'apex');
  assert.deepEqual(commands.filter((args) => args.includes('stat')), [
    ['-s', 'emulator-5554', 'shell', 'stat', '-c', '%d:%i', '/data/local/tmp/android-emu-apex-cacerts', '/apex/com.android.conscrypt/cacerts'],
    ['-s', 'emulator-5554', 'shell', 'nsenter', '-t', '101', '-m', '--', 'stat', '-c', '%d:%i', '/data/local/tmp/android-emu-apex-cacerts', '/apex/com.android.conscrypt/cacerts'],
  ]);
});

test('active APEX default file operations use only the injected runner and clean/finalize the bounded directory', async () => {
  const commands = [];
  const result = await provisionRootCertificates(
    { serial: 'emulator-5554', certificates: [certificate] },
    {
      run: async (_bin, args) => {
        commands.push(args);
        if (args.includes('getprop')) return args.at(-1) === 'ro.build.version.sdk' ? '34' : 'false';
        if (args.includes('ls')) return args.at(-1).includes('/apex/') ? '12345678.0' : '';
        return '';
      },
      waitForBoot: async () => {}, getAndroidCertificateHash: async () => '5a1c3d2e',
      readStoreCertificate: async () => otherCertificateBytes(),
      verifyActiveCertificate: async () => true,
      findZygotePids: async () => [101], bindApexInNamespace: async () => {}, verifyApexMount: async () => true,
    }
  );
  assert.equal(result.store, 'apex');
  assert.equal(commands.some((args) => args.includes('rm') && args.includes(APEX_MERGED_DIRECTORY_PLACEHOLDER)), true);
  assert.equal(commands.some((args) => args.includes('chown')), true);
  assert.equal(commands.some((args) => args.some((arg) => String(arg).includes('chcon'))), true);
});

const APEX_MERGED_DIRECTORY_PLACEHOLDER = '/data/local/tmp/android-emu-apex-cacerts';

function otherCertificateBytes() {
  return fs.readFileSync(path.resolve('certs/yandex/IntermediateCA.pem'));
}
