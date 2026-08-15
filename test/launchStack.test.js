import test from 'node:test';
import assert from 'node:assert/strict';
import { SdkError } from '../src/errors.js';
import {
  buildEffectiveEmulatorArgs,
  launchStack,
  waitForPort,
} from '../src/launchStack.js';

test('buildEffectiveEmulatorArgs replaces stale proxy flags and adds root flags exactly once', () => {
  assert.deepEqual(
    buildEffectiveEmulatorArgs({
      avdName: 'Pixel_8',
      baseArgs: [
        '-avd', 'Wrong_AVD',
        '-http-proxy', 'http://old.proxy:8080',
        '-writable-system',
        '-writable-system',
        '-no-snapshot',
        '-no-snapshot',
      ],
      port: 8181,
      capability: 'root-capable',
    }),
    [
      '-avd', 'Pixel_8',
      '-http-proxy', 'http://127.0.0.1:8181',
      '-writable-system',
      '-no-snapshot',
    ]
  );
});

test('buildEffectiveEmulatorArgs never adds writable-system for magisk-required images', () => {
  const args = buildEffectiveEmulatorArgs({
    avdName: 'Play_Pixel',
    baseArgs: ['-writable-system', '-no-snapshot', '-no-snapshot'],
    port: 8181,
    capability: 'magisk-required',
  });

  assert.equal(args.includes('-writable-system'), false);
  assert.equal(args.filter((arg) => arg === '-no-snapshot').length, 1);
});

test('launchStack prepares a Magisk module without root provisioning and returns its recovery instructions', async () => {
  const calls = [];
  const provisionResult = { changed: true, state: 'missing', instructions: { steps: ['manual'] } };
  const result = await launchStack(
    { avdName: 'Play_Pixel', capability: 'magisk-required', mitmConfig: {} },
    {
      validateScripts: () => {},
      validateTools: () => {},
      listRunningEmulators: () => [],
      findAvailablePort: async () => 8081,
      createPidMarkerPath: () => '/tmp/mitm.pid',
      createTerminalWindow: () => ({ windowId: 731, tty: '/dev/ttys731' }),
      readPidMarker: async () => 4321,
      isProcessAlive: async () => true,
      doesPidOwnPort: async () => true,
      removePidMarker: () => {},
      openTerminalTab: (_windowId, _bin, args) => calls.push(['emulator', args]),
      discoverSerial: async () => 'emulator-5554',
      waitForBoot: async () => {},
      provisionRootCertificates: async () => { throw new Error('must not mutate the system partition'); },
      prepareMagiskModule: async (input) => { calls.push(['magisk', input]); return provisionResult; },
      loadCertificateRegistry: async () => [makeLaunchCertificate()],
    }
  );

  assert.equal(calls.some(([name]) => name === 'magisk'), true);
  assert.equal(calls.find(([name]) => name === 'emulator')[1].includes('-writable-system'), false);
  assert.equal(result.provision, provisionResult);
});

test('launchStack skips certificate mutation for unknown images', async () => {
  let provisioned = false;
  const result = await launchStack(
    { avdName: 'Unknown_Pixel', capability: 'unknown', mitmConfig: {} },
    {
      validateScripts: () => {}, validateTools: () => {}, listRunningEmulators: () => [],
      findAvailablePort: async () => 8081, createPidMarkerPath: () => '/tmp/mitm.pid',
      createTerminalWindow: () => ({ windowId: 731, tty: '/dev/ttys731' }),
      readPidMarker: async () => 4321, isProcessAlive: async () => true, doesPidOwnPort: async () => true,
      removePidMarker: () => {}, openTerminalTab: () => {}, discoverSerial: async () => 'emulator-5554', waitForBoot: async () => {},
      provisionRootCertificates: async () => { provisioned = true; },
      prepareMagiskModule: async () => { provisioned = true; },
    }
  );
  assert.equal(provisioned, false);
  assert.deepEqual(result.provision, { changed: false, skipped: true });
});

function makeLaunchCertificate() {
  return {
    id: 'yandex-root',
    path: '/tmp/yandex-root.pem',
    fingerprint: 'E3:C3:19:26:46:53:6B:C4:FF:AE:6D:DD:43:24:EF:9D:D8:D3:B1:6D:FA:13:A2:4E:13:18:0E:F1:4B:A2:1B:BA',
    androidName: '5a1c3d2e.0',
  };
}

test('waitForPort retries through its injected dependency and stops at its bounded timeout', async () => {
  let now = 0;
  let probes = 0;

  await assert.rejects(
    () => waitForPort(
      { host: '127.0.0.1', port: 8181, timeoutMs: 100, intervalMs: 40 },
      {
        now: () => now,
        sleep: async (ms) => { now += ms; },
        isPortReady: async () => {
          probes += 1;
          return false;
        },
      }
    ),
    (error) => error instanceof SdkError && /Таймаут ожидания/.test(error.message) && /8181/.test(error.message)
  );

  assert.equal(probes, 4);
  assert.equal(now, 100);
});

test('launchStack rejects an already running AVD during validation before opening Terminal', async () => {
  let created = false;

  await assert.rejects(
    () => launchStack(
      { avdName: 'Pixel_8', mitmConfig: {} },
      {
        validateScripts: () => {},
        validateTools: () => {},
        listRunningEmulators: () => [{ name: 'Pixel_8', serial: 'emulator-5554' }],
        findAvailablePort: async () => 8081,
        buildMitmArgs: () => [],
        createTerminalWindow: () => { created = true; return { windowId: 731 }; },
        waitForPort: async () => {},
        openTerminalTab: () => {},
        discoverSerial: async () => 'emulator-5554',
        waitForBoot: async () => {},
      }
    ),
    (error) => error instanceof SdkError && /^Этап "validate"/.test(error.message) && /Pixel_8/.test(error.message)
  );

  assert.equal(created, false);
});

test('launchStack validates the public certificate registry for every capability before opening Terminal', async () => {
  let terminalOpened = false;
  await assert.rejects(
    () => launchStack(
      { avdName: 'Unknown_Pixel', capability: 'unknown', mitmConfig: {} },
      {
        validateScripts: () => {}, validateTools: () => {}, listRunningEmulators: () => [],
        loadCertificateRegistry: async () => { throw new SdkError('повреждён публичный CA'); },
        createTerminalWindow: () => { terminalOpened = true; return { windowId: 1, tty: '/dev/ttys1' }; },
      }
    ),
    (error) => /Этап "validate"/.test(error.message) && /повреждён публичный CA/.test(error.message)
  );
  assert.equal(terminalOpened, false);
});

test('launchStack passes the single validation-stage registry to provisioning without rereading it', async () => {
  const registry = [makeLaunchCertificate()];
  let received;
  await launchStack(
    { avdName: 'Pixel_8', capability: 'root-capable', mitmConfig: {} },
    {
      validateScripts: () => {}, validateTools: () => {}, listRunningEmulators: () => [],
      loadCertificateRegistry: async () => registry, findAvailablePort: async () => 8081,
      createPidMarkerPath: () => '/tmp/mitm.pid', createTerminalWindow: () => ({ windowId: 1, tty: '/dev/ttys1' }),
      readPidMarker: async () => 1, isProcessAlive: async () => true, doesPidOwnPort: async () => true, removePidMarker: () => {},
      openTerminalTab: () => {}, discoverSerial: async () => 'emulator-5554', waitForBoot: async () => {},
      provision: async ({ certificates }) => { received = certificates; return {}; },
    }
  );
  assert.equal(received, registry);
});

test('launchStack rejects every custom mitm port override before opening Terminal', async () => {
  for (const customArgs of ['--listen-port 9090', '--listen-port=9090', '-p 9090']) {
    let created = false;

    await assert.rejects(
      () => launchStack(
        { avdName: 'Pixel_8', mitmConfig: { customArgs } },
        {
          validateScripts: () => {},
          validateTools: () => {},
          listRunningEmulators: () => [],
          findAvailablePort: async () => 8081,
          createTerminalWindow: () => { created = true; return { windowId: 731 }; },
          waitForPort: async () => {},
          openTerminalTab: () => {},
          discoverSerial: async () => 'emulator-5554',
          waitForBoot: async () => {},
        }
      ),
      (error) => error instanceof SdkError && /^Этап "validate"/.test(error.message) && /переопределять порт/.test(error.message),
      customArgs
    );

    assert.equal(created, false, customArgs);
  }
});

test('launchStack preserves an occupied port owner, orders stages, and passes the dynamic proxy to the emulator tab', async () => {
  const events = [];
  const calls = [];
  let now = 0;
  let markerReads = 0;
  const result = await launchStack(
    {
      avdName: 'Pixel_8',
      capability: 'root-capable',
      mitmConfig: { listenPort: 8080, scripts: ['/tmp/addon.py'] },
      onStage: (event) => events.push(`${event.stage}:${event.status}`),
    },
    {
      validateConfig: () => calls.push('validate-config'),
      validateScripts: (scripts) => calls.push(`validate-scripts:${scripts.join(',')}`),
      validateTools: () => calls.push('validate-tools'),
      listRunningEmulators: () => [],
      findAvailablePort: async (port) => {
        calls.push(`find-port:${port}`);
        return 8081;
      },
      buildMitmArgs: (config) => ['--listen-port', String(config.listenPort)],
      createPidMarkerPath: () => '/tmp/mitm-731.pid',
      createTerminalWindow: (command, args, prefix, launchOptions) => {
        calls.push(`create:${command}:${args.join(' ')}:${launchOptions.pidMarkerPath}`);
        return { windowId: 731, tty: '/dev/ttys731' };
      },
      waitForPort: async () => {},
      readPidMarker: async () => {
        markerReads += 1;
        calls.push('read-marker');
        return markerReads === 1 ? null : 4321;
      },
      isProcessAlive: async (pid) => {
        calls.push(`alive:${pid}`);
        return true;
      },
      doesPidOwnPort: async (pid, port) => {
        calls.push(`owns:${pid}:${port}`);
        return true;
      },
      removePidMarker: (markerPath) => calls.push(`remove-marker:${markerPath}`),
      now: () => now,
      sleep: async (ms) => {
        calls.push(`sleep:${ms}`);
        now += ms;
      },
      openTerminalTab: (windowId, command, args) => calls.push(`tab:${windowId}:${command}:${args.join(' ')}`),
      discoverSerial: async (avdName) => {
        calls.push(`serial:${avdName}`);
        return 'emulator-5554';
      },
      waitForBoot: async (serial) => calls.push(`boot:${serial}`),
      provision: async ({ serial, capability }) => {
        calls.push(`provision:${serial}:${capability}`);
        return { changed: false };
      },
    }
  );

  assert.deepEqual(result, { windowId: 731, port: 8081, serial: 'emulator-5554', capability: 'root-capable', provision: { changed: false } });
  assert.deepEqual(calls, [
    'validate-config',
    'validate-scripts:/tmp/addon.py',
    'validate-tools',
    'find-port:8080',
    'create:mitmproxy:--listen-port 8081:/tmp/mitm-731.pid',
    'read-marker',
    'sleep:500',
    'read-marker',
    'alive:4321',
    'owns:4321:8081',
    'remove-marker:/tmp/mitm-731.pid',
    'tab:731:emulator:-avd Pixel_8 -http-proxy http://127.0.0.1:8081 -writable-system -no-snapshot',
    'serial:Pixel_8',
    'boot:emulator-5554',
    'provision:emulator-5554:root-capable',
  ]);
  assert.deepEqual(events, [
    'validate:start', 'validate:success',
    'port:start', 'port:success',
    'mitm:start', 'mitm:success',
    'mitm-ready:start', 'mitm-ready:success',
    'emulator:start', 'emulator:success',
    'serial:start', 'serial:success',
    'boot:start', 'boot:success',
    'provision:start', 'provision:success',
    'ready:success',
  ]);
});

test('launchStack provisions public certificates by default only for root-capable images', async () => {
  const calls = [];
  const registry = [
    { id: 'yandex-root', path: '/certs/root.pem', fingerprint: 'AA:BB' },
    { id: 'mitmproxy', path: '/mitm/mitmproxy-ca-cert.pem', fingerprint: 'CC:DD' },
  ];
  const commonDependencies = {
    validateConfig: () => {},
    validateScripts: () => {},
    validateTools: () => {},
    listRunningEmulators: () => [],
    findAvailablePort: async () => 8081,
    buildMitmArgs: () => [],
    createPidMarkerPath: () => '/tmp/mitm-731.pid',
    createTerminalWindow: () => ({ windowId: 731, tty: '/dev/ttys731' }),
    readPidMarker: async () => 4321,
    isProcessAlive: async () => true,
    doesPidOwnPort: async () => true,
    removePidMarker: () => {},
    openTerminalTab: () => {},
    discoverSerial: async () => 'emulator-5554',
    waitForBoot: async () => {},
    loadCertificateRegistry: ({ includeMitm }) => {
      calls.push(`registry:${includeMitm}`);
      return registry;
    },
    provisionRootCertificates: async ({ serial, certificates }) => {
      calls.push(`provision:${serial}:${certificates.map((certificate) => certificate.id).join(',')}`);
    },
    prepareMagiskModule: async ({ serial, certificates }) => {
      calls.push(`magisk:${serial}:${certificates.map((certificate) => certificate.id).join(',')}`);
      return { changed: false, state: 'current' };
    },
  };

  await launchStack({ avdName: 'Pixel_8', capability: 'root-capable', mitmConfig: {} }, commonDependencies);
  await launchStack({ avdName: 'Play_Pixel', capability: 'magisk-required', mitmConfig: {} }, commonDependencies);
  await launchStack({ avdName: 'Unknown_Pixel', capability: 'unknown', mitmConfig: {} }, commonDependencies);

  assert.deepEqual(calls, [
    'registry:true',
    'provision:emulator-5554:yandex-root,mitmproxy',
    'registry:true',
    'magisk:emulator-5554:yandex-root,mitmproxy',
    'registry:true',
  ]);
});

test('launchStack keeps initial boot waiting separate from the provisioning wait override', async () => {
  const capturedWaiters = [];
  const initialWaitForBoot = async () => {};
  const provisionWaitForBoot = async () => {};
  const launch = async (explicitWaiter) => launchStack(
    { avdName: 'Pixel_8', capability: 'root-capable', mitmConfig: {} },
    {
      validateConfig: () => {},
      validateScripts: () => {},
      validateTools: () => {},
      listRunningEmulators: () => [],
      findAvailablePort: async () => 8081,
      buildMitmArgs: () => [],
      createPidMarkerPath: () => '/tmp/mitm-731.pid',
      createTerminalWindow: () => ({ windowId: 731, tty: '/dev/ttys731' }),
      readPidMarker: async () => 4321,
      isProcessAlive: async () => true,
      doesPidOwnPort: async () => true,
      removePidMarker: () => {},
      openTerminalTab: () => {},
      discoverSerial: async () => 'emulator-5554',
      waitForBoot: initialWaitForBoot,
      provisionWaitForBoot: explicitWaiter,
      loadCertificateRegistry: () => [{ id: 'yandex-root', path: '/certs/root.pem', fingerprint: 'AA:BB' }],
      provisionRootCertificates: async (_options, dependencies) => capturedWaiters.push(dependencies.waitForBoot),
    }
  );

  await launch(undefined);
  await launch(provisionWaitForBoot);

  assert.equal(capturedWaiters[0], undefined);
  assert.equal(capturedWaiters[1], provisionWaitForBoot);
  assert.notEqual(capturedWaiters[0], initialWaitForBoot);
});

test('launchStack reports a stable stage error when the captured Terminal window vanishes', async () => {
  const events = [];

  await assert.rejects(
    () => launchStack(
      { avdName: 'Pixel_8', capability: 'unknown', mitmConfig: {}, onStage: (event) => events.push(event) },
      {
        validateConfig: () => {},
        validateScripts: () => {},
        validateTools: () => {},
        listRunningEmulators: () => [],
        findAvailablePort: async () => 8081,
        buildMitmArgs: () => [],
        createPidMarkerPath: () => '/tmp/mitm-731.pid',
        createTerminalWindow: () => ({ windowId: 731, tty: '/dev/ttys731' }),
        waitForPort: async () => {},
        readPidMarker: async () => 4321,
        isProcessAlive: async () => true,
        doesPidOwnPort: async () => true,
        removePidMarker: () => {},
        openTerminalTab: () => { throw new SdkError('Окно Terminal с id 731 уже закрыто.'); },
      }
    ),
    (error) => error instanceof SdkError && /^Этап "emulator"/.test(error.message) && /Окно Terminal/.test(error.message)
  );

  assert.deepEqual(events.at(-1), {
    stage: 'emulator',
    status: 'error',
    error: 'Окно Terminal с id 731 уже закрыто.',
  });
});

test('launchStack includes exact mitm tab output and cleans its marker when the owned process exits before readiness', async () => {
  let removedMarker = null;
  let openedEmulator = false;

  await assert.rejects(
    () => launchStack(
      { avdName: 'Pixel_8', mitmConfig: {} },
      {
        validateScripts: () => {},
        validateTools: () => {},
        listRunningEmulators: () => [],
        findAvailablePort: async () => 8081,
        createPidMarkerPath: () => '/tmp/mitm-731.pid',
        createTerminalWindow: () => ({ windowId: 731, tty: '/dev/ttys731' }),
        waitForPort: async () => {},
        readPidMarker: async () => 4321,
        isProcessAlive: async () => false,
        doesPidOwnPort: async () => { throw new Error('must not check a dead process'); },
        readTerminalTabOutput: async (windowId, tty) => {
          assert.equal(windowId, 731);
          assert.equal(tty, '/dev/ttys731');
          return 'mitmproxy: error: invalid addon';
        },
        removePidMarker: (markerPath) => { removedMarker = markerPath; },
        openTerminalTab: () => { openedEmulator = true; },
        discoverSerial: async () => 'emulator-5554',
        waitForBoot: async () => {},
      }
    ),
    (error) => error instanceof SdkError && /^Этап "mitm-ready"/.test(error.message) && /invalid addon/.test(error.message)
  );

  assert.equal(removedMarker, '/tmp/mitm-731.pid');
  assert.equal(openedEmulator, false);
});
