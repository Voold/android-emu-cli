import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTerminalScript } from '../src/launch.js';

test('buildTerminalScript shell-quotes every argument', () => {
  assert.equal(
    buildTerminalScript('mitmproxy', ['-s', '/tmp/my addon.py', '$(touch /tmp/nope)'], '/tmp/launcher.sh'),
    "#!/bin/sh\nrm -f '/tmp/launcher.sh'\nexec 'mitmproxy' '-s' '/tmp/my addon.py' '$(touch /tmp/nope)'\n"
  );
});
