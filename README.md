# Android Emulator CLI

Небольшая консольная утилита для создания Android AVD, запуска их с mitmproxy,
просмотра DevTools и безопасной установки публичных CA в Android Emulator на macOS.

## Быстрый старт за пять минут

Нужен только macOS и доступ в интернет. Клонируйте проект и запустите установщик:

```bash
git clone https://github.com/Voold/android-emu-cli.git
cd android-emu-cli
./install.sh
android-emu
```

Перед изменением компьютера установщик перечисляет действия и просит подтверждение.
Он ставит или проверяет Homebrew, Node.js, Android Command-line Tools, emulator,
platform-tools, mitmproxy, npm-зависимости и глобальную команду `android-emu`.
Также mitmproxy один раз создаёт локальный публичный CA. Установщик идемпотентен:
повторный запуск продолжает подготовку, а не переустанавливает всё вручную.

Проверить только план установки, ничего не меняя:

```bash
ANDROID_EMU_DRY_RUN=1 ./install.sh
```

Проверить готовность окружения без изменений:

```bash
android-emu doctor
```

Команда `npm link`, которую запускает установщик, добавляет `android-emu` в PATH.
Если после новой сессии shell команда не находится, перезапустите Terminal либо
проверьте PATH и повторите `npm link` из каталога репозитория.

## Меню и клавиши

Главное меню содержит «Мои устройства», «Создать устройство», DevTools и
самостоятельный запуск mitmproxy. В меню работают `↑`/`↓`, Enter, `←`, `M` и `X`:

- `↑`/`↓` — выбор пункта;
- `←` — назад, `M` — в главное меню;
- `Esc` — отмена текущего ввода или мастера;
- `X` — очистить консоль и завершить программу.

Длинные списки прокручиваются внутри экрана: заголовок и footer неподвижны, а
строки «ещё N выше/ниже» появляются только когда список действительно можно
прокрутить. Даже в компактном Terminal показываются минимум три пункта; fallback
рассчитан на 9 строк. Физический размер окна Terminal утилита не меняет.

## Устройства и образы

При создании профиля есть ровно два варианта: выбрать профиль из списка или
ввести его ID вручную. Ручной ID не может быть пустым. Образ можно выбрать из
списка или указать package ID, например:

```text
system-images;android-34;google_apis;arm64-v8a
```

В списке `◆` означает установленный образ, `◇` — образ, который потребуется
скачать; значение также написано в каждой строке. Образы упорядочены так:

1. `root-capable`: `google_apis`, `default`, `aosp_atd`, `google_atd`;
2. `magisk-required`: `google_apis_playstore`;
3. неизвестная capability.

Для уже существующего AVD утилита сначала read-only читает текущий
package ID из `config.ini` и только при его отсутствии использует сохранённый fallback.
Строка вида
`image.sysdir.1=system-images/android-36/default/arm64-v8a/` превращается в
`system-images;android-36;default;arm64-v8a`. Если определить образ нельзя,
capability остаётся неизвестной: никаких обещаний автоматического provisioning
в этом случае нет.

## Запуск с MITM

MITM включён глобально по умолчанию. У конкретного AVD есть независимый режим:
`inherit`, `enabled` или `disabled`.

Обычный «Запустить» использует сохранённые флаги и этот режим. В «Запустить с
параметрами» выбираются emulator-флаги и режим MITM для одного запуска:

- `inherit` — применить глобальную и AVD-настройку;
- `enabled` — запустить через mitmproxy;
- `disabled` — запустить напрямую.

Если MITM фактически включён, ручной `-http-proxy` не применяется: coordinator
находит свободный порт и добавляет текущий адрес `http://127.0.0.1:<port>`.
Такой динамический proxy никогда не сохраняется среди emulator-флагов. Когда
MITM выключен, можно задать свой proxy. До запуска утилита спрашивает, сохранить
ли выбранные параметры: только подтверждённый ответ записывает флаги, proxy и
AVD MITM-override. Отказ запускает ровно один раз без изменения настроек.

Скрипты mitmproxy, режим, флаги и произвольные аргументы настраиваются отдельным
пунктом «Запустить mitm». Произвольными аргументами нельзя переопределить порт
стека. Занятого владельца порта утилита не убивает — ищет свободный порт.

При MITM-запуске открывается одно новое окно Terminal с двумя вкладками:
интерактивный mitmproxy и логи emulator. Закрытие этого окна завершает
принадлежащие ему процессы. Прямой запуск также открывает отдельный Terminal с
логами emulator.

## Сертификаты на root-capable образах

Для `root-capable` AVD coordinator добавляет `-writable-system` и
`-no-snapshot` только к текущему MITM-сеансу. После загрузки он сверяет
отпечатки, делает `adb root`, отключает verification, когда команда поддержана,
remount’ит `/system` и устанавливает только отсутствующие либо изменившиеся CA.
Команды reboot выполняются исключительно когда их требует Android; после каждого
reboot утилита ждёт загрузку и снова получает root. В конце отпечатки проверяются
повторно, поэтому повторный запуск идемпотентен.

Это не постоянная модификация AVD: writable-system session зависит от запущенного
эмулятора. На Android 14+ с активным Conscrypt APEX утилита создаёт session-only
merged CA store, сохраняет все уже имеющиеся APEX CA и bind-mount’ит его в host и
zygote mount namespaces. Готовность подтверждается только после проверки mount и
отпечатков активного store; при сомнении запуск fail closed. Если приложение уже
было запущено до mount, перезапустите его, чтобы оно получило новый namespace.
В сообщении результата явно указаны installed/skipped и предупреждения с этапом,
включая ожидаемые reboot.

## Google Play и Magisk

`google_apis_playstore` никогда не получает `-writable-system`, не root’ится и
не изменяет system partition автоматически. Утилита строит модуль с публичными
CA и копирует ZIP в:

```text
/storage/emulated/0/Download/android-emu-ca-module.zip
```

Когда состояние `missing` или `stale`, в результат выводятся заметка и точные
ручные шаги:

1. Откройте Magisk → Modules → Install from storage.
2. Выберите `Download/android-emu-ca-module.zip`.
3. Перезагрузите emulator.
4. Ещё раз запустите `android-emu`, чтобы проверить отпечатки.

Состояние `current` означает только успешную проверку CA в активном trust store.
Утилита не устанавливает Magisk, не получает root и не обходит certificate
pinning. На API 34+ модуль учитывает AOSP Conscrypt: APEX store активен только
когда это разрешают SDK/API и `system.certs.enabled`; скрипты монтируют merged CA
также в zygote namespace с ограниченным retry. Логи смотрите через `logcat -s
android-emu-ca`; live-проверка этой namespace-ветки на реальном Google Play AVD
пока остаётся ручным smoke-тестом.

Подробнее: [AOSP Conscrypt](https://source.android.com/docs/core/ota/modular-system/conscrypt)
и [Magisk module guide](https://topjohnwu.github.io/Magisk/guides.html).

## Публичные CA и ротация

В репозитории лежат только публичные Yandex Cloud CA:

- [RootCA.pem](https://storage.yandexcloud.net/cloud-certs/RootCA.pem), SHA-256
  файла `f452434eba62a3704c8b43c229440f2cb4887a6a197777de84c3d6f9cf5afd67`,
  fingerprint `E3:C3:19:26:46:53:6B:C4:FF:AE:6D:D3:43:24:EF:9D:D8:D3:B1:6D:FA:13:A2:4E:13:18:0E:F1:4B:A2:1B:BA`;
- [IntermediateCA.pem](https://storage.yandexcloud.net/cloud-certs/IntermediateCA.pem),
  SHA-256 файла `c6a8224db5f1dbd2bb62329362e466fc5952934c80d8ab21fdbb2ce36d94d989`,
  fingerprint `E1:D5:3D:D1:D7:56:6D:0D:C6:91:C9:ED:6F:CA:0C:91:0F:58:B9:5D:4E:D7:F0:A9:58:AC:C7:67:A1:B2:49:37`.

Канонические URL, subject, сроки и контрольные суммы находятся в
[`certs/yandex/manifest.json`](certs/yandex/manifest.json). `doctor` проверяет
целостность и предупреждает о скором истечении. Intermediate истекает
20 июня 2027 года; до этой даты или при ротации проверьте актуальные Yandex
источники, обновите PEM и manifest одной проверенной поставкой.

Локальный `~/.mitmproxy/mitmproxy-ca-cert.pem` — также только публичный
сертификат. Закрытый ключ mitmproxy не попадает в репозиторий, конфиг или
Magisk-модуль. Certificate pinning приложений эти CA не обходят.

## Ошибки и восстановление

Ошибка сохраняет исходный текст и этап (`validate`, `port`, `mitm`,
`mitm-ready`, `emulator`, `serial`, `boot`, `provision`). До запуска emulator
можно повторить MITM-запуск или один раз запустить напрямую без изменения
настроек. После запуска emulator не предлагаются ни retry, ни прямой fallback:
сначала закройте возможный уже запущенный AVD, затем начните новый безопасный
запуск. Это же правило действует, когда validation сообщает, что AVD уже запущен.

## DevTools

Выберите «Открыть DevTools», затем запущенный emulator и нужную Chrome/WebView
вкладку. Для WebView приложение должно включать `WebContentsDebugging`; утилита
открывает URL frontend, который вернуло само устройство.

## Локальные файлы

Пользовательские данные не пишутся в репозиторий:

```text
~/.android-emu-cli/settings.json
~/.android-emu-cli/launch-defaults.json
~/.android-emu-cli/mitm-config.json
~/.android-emu-cli/magisk/<AVD>.zip
~/.android-emu-cli/magisk/<AVD>.json
~/.mitmproxy/mitmproxy-ca-cert.pem
```

## Проверка разработки

```bash
bash -n install.sh
sh -n assets/magisk/post-fs-data.sh
sh -n assets/magisk/service.sh
ANDROID_EMU_DRY_RUN=1 ./install.sh
npm test
npm pack --dry-run
```

## Ограничения

- Только macOS и Android Virtual Devices; физических устройств нет.
- Google Play AVD не root’ится и Magisk не устанавливается автоматически.
- Certificate pinning не обходится.
- Живой root-capable и Google Play/Magisk smoke-тесты, включая zygote namespace,
  не выполняются unit-тестами и требуют отдельного разрешения.

## Лицензия

ISC. Подробности в [LICENSE](LICENSE).
