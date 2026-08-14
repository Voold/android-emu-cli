import { run, runInteractive } from './sdk.js';
import { SdkError } from './errors.js';

// Используется, если sdkmanager недоступен (нет сети, не приняты лицензии и т.п.)
const FALLBACK_IMAGES = [
  { package: 'system-images;android-34;google_apis_playstore;arm64-v8a', apiLevel: '34', tag: 'google_apis_playstore', abi: 'arm64-v8a', description: 'Android 14.0 (Google Play)', installed: false },
  { package: 'system-images;android-33;google_apis_playstore;arm64-v8a', apiLevel: '33', tag: 'google_apis_playstore', abi: 'arm64-v8a', description: 'Android 13.0 (Google Play)', installed: false },
  { package: 'system-images;android-31;google_apis_playstore;arm64-v8a', apiLevel: '31', tag: 'google_apis_playstore', abi: 'arm64-v8a', description: 'Android 12.0 (Google Play)', installed: false },
  { package: 'system-images;android-30;google_apis_playstore;arm64-v8a', apiLevel: '30', tag: 'google_apis_playstore', abi: 'arm64-v8a', description: 'Android 11.0 (Google Play)', installed: false },
  { package: 'system-images;android-28;google_apis;x86_64', apiLevel: '28', tag: 'google_apis', abi: 'x86_64', description: 'Android 9.0', installed: false },
];

function parseImageLines(section, installed) {
  const images = [];
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('system-images;')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 3) continue;
    const [pkg, version, description] = parts;
    const segments = pkg.split(';');
    images.push({
      package: pkg,
      apiLevel: (segments[1] || '').replace('android-', ''),
      tag: segments[2] || '',
      abi: segments[3] || '',
      version,
      description,
      installed,
    });
  }
  return images;
}

/**
 * Возвращает список системных образов. Пытается получить реальные данные
 * через `sdkmanager --list` (установленные + доступные к загрузке образы).
 * Если это не удаётся — отдаёт статический список как запасной вариант.
 */
export function listSystemImages() {
  let output;
  try {
    output = run('sdkmanager', ['--list']);
  } catch {
    return { images: FALLBACK_IMAGES, usedFallback: true };
  }

  const availableIdx = output.indexOf('Available Packages:');
  const installedSection = availableIdx === -1 ? output : output.slice(0, availableIdx);
  const availableSection = availableIdx === -1 ? '' : output.slice(availableIdx);

  const merged = new Map();
  for (const img of parseImageLines(installedSection, true)) merged.set(img.package, img);
  for (const img of parseImageLines(availableSection, false)) {
    if (!merged.has(img.package)) merged.set(img.package, img);
  }

  const levelSortKey = (level) => {
    const n = parseInt(level, 10);
    return Number.isNaN(n) ? -1 : n;
  };
  const images = [...merged.values()].sort((a, b) => levelSortKey(b.apiLevel) - levelSortKey(a.apiLevel));
  if (images.length === 0) {
    return { images: FALLBACK_IMAGES, usedFallback: true };
  }
  return { images, usedFallback: false };
}

const HOST_ABI = { arm64: 'arm64-v8a', x64: 'x86_64' }[process.arch];
const RECOMMENDED_TAGS = new Set(['google_apis_playstore', 'google_apis', 'default', 'google_atd', 'aosp_atd']);

/**
 * Сужает список образов до типичных телефонных/планшетных вариантов под
 * архитектуру этого хоста, без уровней-расширений (-extNN) и preview-сборок —
 * иначе список из sdkmanager (300+ пунктов) невозможно нормально пролистать.
 */
export function filterRecommendedImages(images) {
  return images.filter(
    (img) =>
      /^[0-9]+$/.test(img.apiLevel) &&
      RECOMMENDED_TAGS.has(img.tag) &&
      (!HOST_ABI || img.abi === HOST_ABI)
  );
}

export function installSystemImage(pkg) {
  const status = runInteractive('sdkmanager', ['--install', pkg]);
  if (status !== 0) {
    throw new SdkError(`Не удалось установить образ "${pkg}" (sdkmanager завершился с кодом ${status}).`);
  }
}
