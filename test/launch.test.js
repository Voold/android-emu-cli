import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildTerminalScript,
  createTerminalWindow,
  openTerminalTab,
  readTerminalTabOutput,
} from '../src/launch.js';
import { SdkError } from '../src/errors.js';

const TERMINAL_SDEF = '/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.sdef';

test('buildTerminalScript shell-quotes every argument', () => {
  assert.equal(
    buildTerminalScript('mitmproxy', ['-s', '/tmp/my addon.py', '$(touch /tmp/nope)'], '/tmp/launcher.sh'),
    "#!/bin/sh\nrm -f '/tmp/launcher.sh'\nexec 'mitmproxy' '-s' '/tmp/my addon.py' '$(touch /tmp/nope)'\n"
  );
});

test('createTerminalWindow removes its generated script when AppleScript submission fails', () => {
  let writtenPath;
  let removedPath;
  assert.throws(
    () => createTerminalWindow('emulator', ['-avd', 'Pixel_8'], 'android-emu-test', {
      platform: 'darwin',
      scriptPath: '/tmp/android-emu-terminal-failure.sh',
      writeFile: (target) => { writtenPath = target; },
      removeFile: (target) => { removedPath = target; },
      runAppleScript: () => ({ status: 1, stderr: 'denied' }),
    }),
    /Не удалось открыть новое окно Terminal/iu
  );
  assert.equal(writtenPath, '/tmp/android-emu-terminal-failure.sh');
  assert.equal(removedPath, '/tmp/android-emu-terminal-failure.sh');
});

test('buildTerminalScript writes its owned PID marker immediately before exec', () => {
  assert.equal(
    buildTerminalScript('mitmproxy', ['--listen-port', '8081'], '/tmp/launcher.sh', { pidMarkerPath: '/tmp/mitm.pid' }),
    "#!/bin/sh\nrm -f '/tmp/launcher.sh'\nprintf '%s\\n' \"$$\" > '/tmp/mitm.pid'\nexec 'mitmproxy' '--listen-port' '8081'\n"
  );
});

test('createTerminalWindow captures the exact created Terminal window id and tty without tab id', () => {
  const calls = [];
  const writes = [];

  const result = createTerminalWindow(
    'mitmproxy',
    ['-s', '/tmp/addon "quoted".py'],
    'android-emu-mitm',
    {
      platform: 'darwin',
      scriptPath: '/tmp/android-emu-mitm.sh',
      writeFile: (...args) => writes.push(args),
      runAppleScript: (script) => {
        calls.push(script);
        return { status: 0, stdout: '731:/dev/ttys001\n' };
      },
    }
  );

  assert.deepEqual(result, { windowId: 731, tty: '/dev/ttys001' });
  assert.equal(writes.length, 1);
  assert.match(writes[0][1], /'\/tmp\/addon "quoted"\.py'/);
  assert.match(calls[0], /set terminalTab to do script "bash '\/tmp\/android-emu-mitm\.sh'"/);
  assert.match(calls[0], /return \(id of window of terminalTab\) & ":" & \(tty of terminalTab\)/);
  assert.doesNotMatch(calls[0], /\bid of terminalTab\b/);
});

test('readTerminalTabOutput iterates only the captured window and matches an escaped tty', () => {
  const calls = [];
  const tty = '/dev/ttys001"quoted\\path';

  const output = readTerminalTabOutput(731, tty, {
    platform: 'darwin',
    runAppleScript: (script) => {
      calls.push(script);
      return { status: 0, stdout: 'mitmproxy: failed\n' };
    },
  });

  assert.equal(output, 'mitmproxy: failed');
  assert.match(calls[0], /repeat with candidateTab in tabs of window id 731/);
  assert.ok(calls[0].includes('if (tty of candidateTab) is "/dev/ttys001\\"quoted\\\\path" then'));
  assert.doesNotMatch(calls[0], /selected tab|front window|\btab id\b/);
});

test('Terminal dictionary declares the tab tty property when the macOS dictionary is available', {
  skip: process.platform !== 'darwin' || !fs.existsSync(TERMINAL_SDEF),
}, () => {
  const dictionary = fs.readFileSync(TERMINAL_SDEF, 'utf8');
  const tabClass = dictionary.match(/<class name="tab"[\s\S]*?<\/class>/)?.[0] || '';

  assert.match(tabClass, /<property name="tty"\s[\s\S]*?<\/property>/);
});

test('openTerminalTab targets only the captured Terminal window id', () => {
  const calls = [];

  openTerminalTab(731, 'emulator', ['-avd', 'Pixel_8'], 'android-emu-emulator', {
    platform: 'darwin',
    scriptPath: '/tmp/android-emu-emulator.sh',
    writeFile: () => {},
    runAppleScript: (script) => {
      calls.push(script);
      return { status: 0, stdout: '' };
    },
  });

  assert.match(calls[0], /do script "bash '\/tmp\/android-emu-emulator\.sh'" in window id 731/);
  assert.doesNotMatch(calls[0], /front window/);
});

test('openTerminalTab rejects a vanished captured window instead of opening elsewhere', () => {
  assert.throws(
    () => openTerminalTab(731, 'emulator', ['-avd', 'Pixel_8'], 'android-emu-emulator', {
      platform: 'darwin',
      scriptPath: '/tmp/android-emu-emulator.sh',
      writeFile: () => {},
      runAppleScript: () => ({ status: 1, stderr: 'Terminal got an error: Can\'t get window id 731.' }),
    }),
    (error) => error instanceof SdkError && /Окно Terminal/.test(error.message) && /731/.test(error.message)
  );
});
