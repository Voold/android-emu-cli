import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(import.meta.dirname, '..');

function writeCommand(directory, name, body) {
  const commandPath = path.join(directory, name);
  fs.writeFileSync(commandPath, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

test('install keeps accepting SDK licenses when sdkmanager closes stdin', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-install-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binDirectory = path.join(directory, 'bin');
  const homeDirectory = path.join(directory, 'home');
  const sdkDirectory = path.join(directory, 'sdk');
  const completionMarker = path.join(directory, 'doctor-ran');
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.mkdirSync(path.join(homeDirectory, '.mitmproxy'), { recursive: true });
  fs.writeFileSync(path.join(homeDirectory, '.mitmproxy', 'mitmproxy-ca-cert.pem'), 'test certificate');

  writeCommand(binDirectory, 'uname', 'printf Darwin');
  writeCommand(binDirectory, 'brew', 'exit 0');
  writeCommand(binDirectory, 'sdkmanager', `
if [[ "$1" == '--licenses' ]]; then
  IFS= read -r _
fi
exit 0`);
  writeCommand(binDirectory, 'openssl', 'exit 0');
  writeCommand(binDirectory, 'npm', 'exit 0');
  writeCommand(binDirectory, 'android-emu', `touch '${completionMarker}'`);

  const result = spawnSync('bash', ['install.sh'], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: 'y\n',
    env: {
      ...process.env,
      PATH: `${binDirectory}:/usr/bin:/bin`,
      HOME: homeDirectory,
      ANDROID_HOME: sdkDirectory,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(completionMarker), true);
});

test('install propagates a failed SDK license acceptance and skips final doctor', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-install-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binDirectory = path.join(directory, 'bin');
  const homeDirectory = path.join(directory, 'home');
  const sdkDirectory = path.join(directory, 'sdk');
  const completionMarker = path.join(directory, 'doctor-ran');
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.mkdirSync(path.join(homeDirectory, '.mitmproxy'), { recursive: true });
  fs.writeFileSync(path.join(homeDirectory, '.mitmproxy', 'mitmproxy-ca-cert.pem'), 'test certificate');

  writeCommand(binDirectory, 'uname', 'printf Darwin');
  writeCommand(binDirectory, 'brew', 'exit 0');
  writeCommand(binDirectory, 'sdkmanager', `
if [[ "$1" == '--licenses' ]]; then
  exit 7
fi
exit 0`);
  writeCommand(binDirectory, 'openssl', 'exit 0');
  writeCommand(binDirectory, 'npm', 'exit 0');
  writeCommand(binDirectory, 'android-emu', `touch '${completionMarker}'`);

  const result = spawnSync('bash', ['install.sh'], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: 'y\n',
    env: {
      ...process.env,
      PATH: `${binDirectory}:/usr/bin:/bin`,
      HOME: homeDirectory,
      ANDROID_HOME: sdkDirectory,
    },
  });

  assert.equal(result.status, 7, result.stderr || result.stdout);
  assert.equal(fs.existsSync(completionMarker), false);
});

test('install rejects an unreadable mitmproxy PEM instead of treating its file name as readiness', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-install-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binDirectory = path.join(directory, 'bin');
  const homeDirectory = path.join(directory, 'home');
  const sdkDirectory = path.join(directory, 'sdk');
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.mkdirSync(path.join(homeDirectory, '.mitmproxy'), { recursive: true });
  fs.writeFileSync(path.join(homeDirectory, '.mitmproxy', 'mitmproxy-ca-cert.pem'), 'not a certificate');

  writeCommand(binDirectory, 'uname', 'printf Darwin');
  writeCommand(binDirectory, 'brew', 'exit 0');
  writeCommand(binDirectory, 'sdkmanager', 'exit 0');
  writeCommand(binDirectory, 'openssl', 'exit 1');
  writeCommand(binDirectory, 'npm', 'exit 0');
  writeCommand(binDirectory, 'android-emu', 'exit 0');

  const result = spawnSync('bash', ['install.sh'], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: 'y\n',
    env: {
      ...process.env,
      PATH: `${binDirectory}:/usr/bin:/bin`,
      HOME: homeDirectory,
      ANDROID_HOME: sdkDirectory,
    },
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /не проходит проверку openssl/i);
});

test('install rejects a parseable mitmproxy certificate when a private-key block is appended', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-install-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binDirectory = path.join(directory, 'bin');
  const homeDirectory = path.join(directory, 'home');
  const sdkDirectory = path.join(directory, 'sdk');
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.mkdirSync(path.join(homeDirectory, '.mitmproxy'), { recursive: true });
  const pemPath = path.join(homeDirectory, '.mitmproxy', 'mitmproxy-ca-cert.pem');
  fs.copyFileSync(path.join(projectRoot, 'certs/yandex/RootCA.pem'), pemPath);
  fs.appendFileSync(pemPath, '\n-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n');

  writeCommand(binDirectory, 'uname', 'printf Darwin');
  writeCommand(binDirectory, 'brew', 'exit 0');
  writeCommand(binDirectory, 'sdkmanager', 'exit 0');
  writeCommand(binDirectory, 'openssl', 'exit 0');
  writeCommand(binDirectory, 'npm', 'exit 0');
  writeCommand(binDirectory, 'android-emu', 'exit 0');

  const result = spawnSync('bash', ['install.sh'], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: 'y\n',
    env: {
      ...process.env,
      PATH: `${binDirectory}:/usr/bin:/bin`,
      HOME: homeDirectory,
      ANDROID_HOME: sdkDirectory,
    },
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /закрыт(ый|ого) ключ/i);
});

test('fresh Homebrew bootstrap activates brew shellenv before later installer commands', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-install-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binDirectory = path.join(directory, 'bin');
  const homeDirectory = path.join(directory, 'home');
  const sdkDirectory = path.join(directory, 'sdk');
  const shellenvMarker = path.join(directory, 'shellenv-ran');
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.mkdirSync(path.join(homeDirectory, '.mitmproxy'), { recursive: true });
  fs.copyFileSync(path.join(projectRoot, 'certs/yandex/RootCA.pem'), path.join(homeDirectory, '.mitmproxy', 'mitmproxy-ca-cert.pem'));

  writeCommand(binDirectory, 'uname', 'printf Darwin');
  writeCommand(binDirectory, 'curl', `
printf '%s\\n' "mkdir -p '${binDirectory}'"
printf '%s\\n' "cat > '${binDirectory}/brew' <<'BREWEOF'"
printf '%s\\n' '#!/usr/bin/env bash'
printf '%s\\n' 'if [[ "$1" == "shellenv" ]]; then'
printf '%s\\n' '  touch "${shellenvMarker}"'
printf '%s\\n' '  echo "export PATH=${binDirectory}:$PATH"'
printf '%s\\n' 'fi'
printf '%s\\n' 'BREWEOF'
printf '%s\\n' "chmod +x '${binDirectory}/brew'"`);
  writeCommand(binDirectory, 'sdkmanager', 'exit 0');
  writeCommand(binDirectory, 'openssl', 'exit 0');
  writeCommand(binDirectory, 'npm', 'exit 0');
  writeCommand(binDirectory, 'android-emu', 'exit 0');

  const result = spawnSync('bash', ['install.sh'], {
    cwd: projectRoot, encoding: 'utf8', input: 'y\n',
    env: { ...process.env, PATH: `${binDirectory}:/usr/bin:/bin`, HOME: homeDirectory, ANDROID_HOME: sdkDirectory },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(shellenvMarker), true);
});

test('clean Apple Silicon dry-run prints the future Homebrew shellenv path without requiring brew', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-install-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binDirectory = path.join(directory, 'bin');
  const homeDirectory = path.join(directory, 'home');
  fs.mkdirSync(binDirectory, { recursive: true });
  writeCommand(binDirectory, 'uname', '[[ "$1" == "-m" ]] && printf arm64 || printf Darwin');

  const result = spawnSync('bash', ['install.sh'], {
    cwd: projectRoot, encoding: 'utf8',
    env: { ...process.env, PATH: `${binDirectory}:/usr/bin:/bin`, HOME: homeDirectory, ANDROID_EMU_DRY_RUN: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /would eval "\/opt\/homebrew\/bin\/brew shellenv"/);
});

test('dry-run never executes shellenv for an already available brew', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-emu-install-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binDirectory = path.join(directory, 'bin');
  const marker = path.join(directory, 'shellenv-ran');
  fs.mkdirSync(binDirectory, { recursive: true });
  writeCommand(binDirectory, 'uname', 'printf Darwin');
  writeCommand(binDirectory, 'brew', `if [[ "$1" == shellenv ]]; then touch '${marker}'; fi`);
  const result = spawnSync('bash', ['install.sh'], {
    cwd: projectRoot, encoding: 'utf8',
    env: { ...process.env, PATH: `${binDirectory}:/usr/bin:/bin`, HOME: path.join(directory, 'home'), ANDROID_EMU_DRY_RUN: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(marker), false);
  assert.match(result.stdout, /would eval/);
});
