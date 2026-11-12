# Минимальный выпуск исправления интерфейса

Владелец меняет только `deploy/publish-stars-ui.py`,
`deploy/test_publish_stars_ui.py`, этот handoff. Никакого SSH, сети,
production, commit/push, субагентов или правок чужих файлов.

Publisher переиспользует только safe IO/json/health helpers из соседнего
`publish-stars.py` через importlib. Оба файла root загружает рядом, в приватный
контролируемый каталог. Системные пути и root publisher задаёт сам скрипт;
параметров произвольной директории назначения нет.

## Contract

ZIP: строго manifest.json и payload/<repoPath> для каждого файла:

```json
{"revision":"40 lowercase hex Git revision","files":{"Фронт/gamification.js":{"before":"real server sha256","sha256":"payload sha256"},"backend/auth/stars-core.mjs":{"before":"real server sha256","sha256":"payload sha256"}}}
```

`before` обязателен и не может быть null: эта поправка заменяет только реально
существующие файлы. Allowlist: только backend/auth/stars-core.mjs и прямые
Фронт/*.{html,js,css}. Admin, assets, другие backend, SQL, env, config, docs и
зависимости запрещены. ROOT=/opt/wep_pril; Фронт/x → frontend/x.
Нормализованные relative пути, запрет symlink во всех компонентах, ZIP без
duplicate/extra/encrypted/symlink/directory entries, до 100 записей,
3 MB на файл и 20 MB на ZIP/суммарную распаковку. JSON duplicate keys запрещены.

Перед сборкой root создаёт paths.json — JSON массив точного списка файлов.
Вызов на сервере:

```sh
sudo -n python3 /home/webpril-admin/publish-stars-ui.py --inspect /home/webpril-admin/paths.json
```

Выход только `{"files":{"repoPath":"current server sha256"}}`.
Root переносит эти хеши в before, считает payload sha256 и revision.
Отсутствующий файл/неразрешённый путь вызывает отказ; содержимое не выводится.

```sh
sudo -n python3 /home/webpril-admin/publish-stars-ui.py /home/webpril-admin/stars-ui.zip
sudo -n python3 /home/webpril-admin/publish-stars-ui.py /home/webpril-admin/stars-ui.zip --apply
```

По умолчанию preflight полностью read-only (кроме координационных lock-файлов):
manifest/ZIP/hash/path checks, текущие файлы+metadata, синтаксис всех JS/MJS
и inline JS из HTML через `/usr/local/bin/node --input-type=module --check`,
без выполнения проверяемого кода. JSON script blocks не проверяются как JS.
Health — loopback auth session и article API + systemd active обоих сервисов.
БД/схема/настройки/контент/env/nginx/node_modules не читаются для изменения
и не меняются. Нет npm, SQL, pg_restore, генерации ключей или push.

Apply создаёт root-private `/opt/wep_pril/stars-ui-release-<uuid>` с исходными
файлами, manifest и restore-map (before/after hash + mode/uid/gid). Повторно
сверяет исходные байты И metadata. Атомарно заменяет файлы с сохранением
исходных mode/uid/gid, scripts/styles перед HTML, без записи неизменённых.
Если stars-core включён И фактически меняется — чисто останавливает только
wep-pril-auth с timeout110s и проверкой ActiveState/Result, после записи
запускает auth и health. Если только frontend или неизменённый core — stop/start
нет. Article API не перезапускает никогда. Схема и пользовательские данные
не затрагиваются; DB-backup/restore этому выпуску не нужны.

При полном совпадении всех payload текущим файлам после syntax/health выдаёт
STARS_UI_ALREADY_INSTALLED без записи/остановки. Частичный выпуск не принимается
за успешный повтор: применяется обычная проверка всех before.

При ошибке после начала apply откат проверяет ВСЕ записанные файлы/metadata
перед восстановлением любого из них; восстанавливает только этот набор,
при необходимости останавливает/запускает только auth. Конкурентную правку
не затирает: UI_ROLLBACK_INCOMPLETE, marker fix-forward-required в backup,
auth может оставаться остановлен, root разбирает marker и чинит согласованный
набор. Секреты/пользовательские данные и stderr subprocess не выводятся.
Временная папка резервной копии сохраняется до ревизии оператора.

## Локальная проверка

`python -B -m unittest discover -s deploy -p test_publish_stars_ui.py -v`.
10 тестов: allowlist/traversal, before/payload mismatch, nullable before отказ,
extra ZIP отказ, auth restart conditional/unchanged core, metadata preservation,
rollback concurrent precheck всего набора, health-failure rollback, syntax
команда + HTML inline, реальный локальный Node valid/invalid syntax, inspect
только хеши и запрет отсутствующего файла. Сервисы/health под mock, никакого
подключения к production. Финальный результат: **10/10 passed**, без skips.
Реальный локальный Node подтвердил valid/invalid syntax; production preflight
и пользовательские сценарии проверяет только root после UI QA.
