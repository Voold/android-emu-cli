import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SdkError } from './errors.js';

const STORE_DIR = path.join(os.homedir(), '.android-emu-cli');
const STORE_PATH = path.join(STORE_DIR, 'launch-defaults.json');

function readStore(storePath = STORE_PATH) {
  try {
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!store || typeof store !== 'object' || Array.isArray(store)) {
      throw new SdkError(`Некорректный формат параметров запуска: ${storePath}. Ожидается JSON-объект.`);
    }
    return store;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (error instanceof SdkError) throw error;
    throw new SdkError(`Не удалось прочитать параметры запуска: ${storePath}. ${error.message}`);
  }
}

function writeStore(store, storePath = STORE_PATH) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

export function getLaunchDefaults(avdName, storePath = STORE_PATH) {
  return readStore(storePath)[avdName] || null;
}

export function setLaunchDefaults(avdName, updates, storePath = STORE_PATH) {
  const store = readStore(storePath);
  store[avdName] = { ...store[avdName], ...updates };
  writeStore(store, storePath);
}

export function clearLaunchDefaults(avdName, storePath = STORE_PATH) {
  const store = readStore(storePath);
  if (avdName in store) {
    delete store[avdName];
    writeStore(store, storePath);
  }
}
