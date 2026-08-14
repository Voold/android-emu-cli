import inquirer from 'inquirer';
import chalk from 'chalk';
import { spinner } from '../spinner.js';
import { ui } from '../ui.js';
import { listDeviceDefinitions, createAvd, listAvds } from '../avd.js';
import { listSystemImages, installSystemImage, filterRecommendedImages } from '../images.js';
import { launchEmulator } from '../launch.js';
import { selectMenu, checkNav, clearScreen, BACK } from '../menu.js';

async function pickDeviceProfile() {
  const mode = checkNav(
    await selectMenu({
      title: 'Профиль устройства',
      choices: [
        { name: 'Выбрать из списка', value: 'list' },
        { name: 'Ввести вручную', value: 'manual' },
        { name: 'Без профиля (авто)', value: 'none' },
      ],
    })
  );

  if (mode === BACK) return BACK;
  if (mode === 'none') return null;

  if (mode === 'manual') {
    clearScreen();
    const { customDevice } = await inquirer.prompt([
      { type: 'input', name: 'customDevice', message: 'Введите ID устройства (например pixel_6):' },
    ]);
    return customDevice.trim() || null;
  }

  const sp = spinner('Получаю список определений устройств...');
  let devices;
  try {
    devices = listDeviceDefinitions();
    sp.succeed(`Найдено профилей устройств: ${devices.length}.`);
  } catch (err) {
    sp.fail('Не удалось получить список профилей устройств.');
    throw err;
  }

  const deviceId = checkNav(
    await selectMenu({
      title: 'Профиль устройства — выберите из списка',
      choices: devices.map((d) => ({
        name: `${d.name} ${chalk.gray(`(${d.oem}${d.tag ? ', ' + d.tag : ''})`)}`,
        value: d.id,
      })),
    })
  );

  if (deviceId === BACK) return pickDeviceProfile();
  return deviceId;
}

function imageChoice(img) {
  return {
    name: `${img.installed ? '◆' : '◇'} Android API ${img.apiLevel} — ${img.tag}/${img.abi}${
      img.description ? '  ' + chalk.gray(img.description) : ''
    }`,
    value: img.package,
  };
}

/** Возвращает BACK, либо { package, installed }. */
async function pickSystemImage() {
  const mode = checkNav(
    await selectMenu({
      title: 'Системный образ',
      choices: [
        { name: 'Выбрать из списка', value: 'list' },
        { name: 'Ввести вручную (package id)', value: 'manual' },
      ],
    })
  );

  if (mode === BACK) return BACK;

  if (mode === 'manual') {
    clearScreen();
    const { customPackage } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customPackage',
        message: 'Введите package id образа (например system-images;android-34;google_apis;arm64-v8a):',
        validate: (v) => v.trim() !== '' || 'Введите package id',
      },
    ]);
    return { package: customPackage.trim(), installed: false };
  }

  const sp = spinner('Получаю список системных образов (sdkmanager --list)...');
  let images;
  let usedFallback;
  try {
    ({ images, usedFallback } = listSystemImages());
    if (usedFallback) {
      sp.warn('Не удалось получить актуальный список через sdkmanager — показан базовый список образов.');
    } else {
      sp.succeed(`Найдено образов: ${images.length}.`);
    }
  } catch (err) {
    sp.fail('Ошибка получения списка образов.');
    throw err;
  }

  const recommended = usedFallback ? images : filterRecommendedImages(images);
  let pool = recommended.length > 0 ? recommended : images;
  let showingAll = pool === images;

  while (true) {
    const choices = [
      { separator: true, name: '◆ установлен   ◇ не установлен (потребуется загрузка)' },
      ...pool.map(imageChoice),
      ...(showingAll ? [] : [{ name: `Показать все образы (${images.length})`, value: '__show_all__' }]),
    ];
    const answer = checkNav(await selectMenu({ title: 'Системный образ — выберите из списка', choices }));

    if (answer === BACK) return pickSystemImage();
    if (answer === '__show_all__') {
      pool = images;
      showingAll = true;
      continue;
    }

    const picked = images.find((i) => i.package === answer);
    return { package: answer, installed: picked?.installed ?? false };
  }
}

export async function createDeviceMenu() {
  const deviceId = await pickDeviceProfile();
  if (deviceId === BACK) return;

  const imageResult = await pickSystemImage();
  if (imageResult === BACK) return;
  const { package: imagePackage, installed } = imageResult;

  if (!installed) {
    clearScreen();
    const { confirmInstall } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmInstall',
        message: `Образ "${imagePackage}" не отмечен как установленный. Установить/проверить сейчас через sdkmanager?`,
        default: true,
      },
    ]);
    if (confirmInstall) {
      try {
        ui.info('Запускаю sdkmanager --install (могут появиться вопросы о лицензии — отвечайте прямо в терминале)...');
        installSystemImage(imagePackage);
        ui.success('Образ установлен.');
      } catch (err) {
        ui.error(err.message);
        await ui.pause();
        return;
      }
    }
  }

  let existingNames = new Set();
  try {
    existingNames = new Set(listAvds().map((a) => a.name));
  } catch {
    // не критично — просто не сможем проверить дубликаты заранее
  }

  clearScreen();
  const { name } = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Имя нового устройства:',
      validate: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return 'Введите имя';
        if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
          return 'Разрешены только буквы, цифры, "_", "." и "-" (без пробелов)';
        }
        if (existingNames.has(trimmed)) return `Устройство с именем "${trimmed}" уже существует`;
        return true;
      },
    },
  ]);
  const trimmedName = name.trim();

  const sp = spinner(`Создаю устройство "${trimmedName}"...`);
  try {
    createAvd({ name: trimmedName, systemImagePackage: imagePackage, deviceId });
    sp.succeed(`Устройство "${trimmedName}" создано.`);
  } catch (err) {
    sp.fail('Не удалось создать устройство.');
    ui.error(err.message);
    await ui.pause();
    return;
  }

  const { launchNow } = await inquirer.prompt([
    { type: 'confirm', name: 'launchNow', message: 'Запустить его прямо сейчас?', default: false },
  ]);
  if (launchNow) {
    try {
      launchEmulator(['-avd', trimmedName]);
      ui.success('Эмулятор запускается в новом окне Terminal.');
    } catch (err) {
      ui.error(err.message);
    }
  }
  await ui.pause();
}
