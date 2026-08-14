import os from 'node:os';
import path from 'node:path';
import { run, runInteractive } from './sdk.js';

function parseAvdList(output) {
  const [validSection] = output.split('The following Android Virtual Devices could not be loaded:');
  const blocks = validSection
    .split(/^-{3,}$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  const avds = [];
  for (const block of blocks) {
    const avd = { name: null, device: null, path: null, target: null };
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('Name:')) avd.name = line.slice('Name:'.length).trim();
      else if (line.startsWith('Device:')) avd.device = line.slice('Device:'.length).trim();
      else if (line.startsWith('Path:')) avd.path = line.slice('Path:'.length).trim();
      else if (line.startsWith('Based on:')) avd.target = line.slice('Based on:'.length).trim();
    }
    if (avd.name) avds.push(avd);
  }
  return avds;
}

export function listAvds() {
  const output = run('avdmanager', ['list', 'avd']);
  return parseAvdList(output);
}

function parseDeviceDefinitions(output) {
  const blocks = output
    .split(/^-{3,}$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  const devices = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim());
    const headerLineIdx = lines.findIndex((l) => /^id:\s*\d+\s*or\s*"[^"]+"/.test(l));
    if (headerLineIdx === -1) continue;

    const headerMatch = lines[headerLineIdx].match(/^id:\s*(\d+)\s*or\s*"([^"]+)"/);
    const [, index, stringId] = headerMatch;
    const fields = {};
    for (const line of lines.slice(headerLineIdx + 1)) {
      const m = line.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
      if (m) fields[m[1]] = m[2].trim();
    }

    devices.push({
      id: stringId || index,
      index,
      name: fields.Name || stringId || `device #${index}`,
      oem: fields.OEM || '',
      tag: fields.Tag || '',
    });
  }
  return devices;
}

export function listDeviceDefinitions() {
  const output = run('avdmanager', ['list', 'device']);
  return parseDeviceDefinitions(output);
}

export function createAvd({ name, systemImagePackage, deviceId }) {
  const args = ['create', 'avd', '-n', name, '-k', systemImagePackage];
  if (deviceId) args.push('-d', deviceId);
  // avdmanager иногда спрашивает "Do you wish to create a custom hardware
  // profile? [no]" — отвечаем по умолчанию, чтобы не зависнуть на stdin.
  run('avdmanager', args, { input: '\n' });
}

export function deleteAvd(name) {
  run('avdmanager', ['delete', 'avd', '-n', name]);
}

export function avdConfigPath(name) {
  return path.join(os.homedir(), '.android', 'avd', `${name}.avd`, 'config.ini');
}

export function openAvdConfig(name) {
  const editorCmd = process.env.VISUAL || process.env.EDITOR || 'vi';
  const [editorBin, ...editorArgs] = editorCmd.split(' ');
  return runInteractive(editorBin, [...editorArgs, avdConfigPath(name)]);
}
