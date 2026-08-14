import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE_DIR = path.join(os.homedir(), '.android-emu-cli');
const STORE_PATH = path.join(STORE_DIR, 'launch-defaults.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function getLaunchDefaults(avdName) {
  return readStore()[avdName] || null;
}

export function setLaunchDefaults(avdName, { selectedFlagValues, proxy }) {
  const store = readStore();
  store[avdName] = { selectedFlagValues, proxy };
  writeStore(store);
}

export function clearLaunchDefaults(avdName) {
  const store = readStore();
  if (avdName in store) {
    delete store[avdName];
    writeStore(store);
  }
}
