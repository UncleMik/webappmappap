# Выпуск «Звёздочки»: контракт publisher

`deploy/publish-stars.py` запускается Python 3.9+ через sudo на Timeweb.
Он не использует SSH, npm, не утверждает контент и не расширяет аудиторию.
По умолчанию выполняет preflight; `--apply` запускает выпуск. Публикация
и сборка архивов остаются за оркестратором.

## Архив приложения

ZIP содержит строго `manifest.json`, `course-durations.json` и
`payload/<repo-relative-name>` для каждого файла манифеста. Без каталогов,
симлинков, дубликатов, шифрования и других записей. Лимиты: ZIP/суммарная
распаковка 60 MB, файл 10 MB, не более 500 записей.

```json
{
  "revision": "40 lowercase hex characters from the reviewed Git revision",
  "files": {
    "backend/auth/main.mjs": {"before": "real server sha256", "sha256": "payload sha256"},
    "backend/auth/stars-migration.sql": {"before": null, "sha256": "payload sha256"}
  },
  "configBefore": {"nginx": "sha256", "authEnv": "sha256", "adminEnv": "sha256"},
  "durations": {"before": null, "sha256": "course-durations.json sha256"}
}
```

`before` обязателен для каждого файла: фактический SHA256 текущего серверного
файла; `null` означает строго отсутствие. Локальный Git diff не является
источником `before`. Конфиги всегда должны существовать; их содержимое и
секреты не включаются в архив. Манифест и архив хранить приватно.

Разрешены `backend/auth/*.{mjs,sql,json}`, `backend/server.mjs`, оба
`backend/package*.json`, три JSON из `backend/content/` (gamification-source,
gamification-materials-reference, weekly-video-materials), прямые
`Фронт/*.{html,js,css}`, прямые `Фронт/admin/*.{html,js,css}`. Никаких тестов,
документов, env, приватного видеоинвентаря или исходных ссылок на видео.
Файлы админки отображаются в `/opt/wep_pril/admin-frontend/`, пользовательские
в `/opt/wep_pril/frontend/`, backend — в `/opt/wep_pril/backend/`.

В архив обязательно включить package.json, package-lock.json и ровно четыре
новых миграции: stars, stars-ai, gamification, gamification-admin. Другие
SQL могут быть исходными файлами релиза, но publisher их не исполняет.
Включить все изменённые и новые runtime-файлы и зависимости импортов,
определённые интеграцией; publisher не угадывает полноту набора модулей.

Приватный `course-durations.json` имеет `{"version":1,"rows":[...]}`.
Каждая строка строго `{lessonId,videoKey,contentHash,durationMs,provider}`:
lessonId — строка ID, videoKey — `0:0`, contentHash — SHA256 содержимого урока,
durationMs — положительное целое, provider — getcourse/youtube/rutube.
Ровно 1145 проверенных строк, без URL. Два неизвестных видео сюда не включать:
они остаются без подтверждённой длительности и не получают награду как
подтверждённые просмотры. Файл устанавливается в
`/etc/wep-pril-media/course-durations.json`, каталог 0750 root:995,
файл 0640 root:995.

## Получение фактических хешей

Оркестратор создаёт приватный `release-paths.json`: JSON-массив путей
репозитория, которые войдут в ZIP. На сервер передаются скрипт и этот список.

```sh
sudo -n python3 /home/webpril-admin/publish-stars.py --inspect /home/webpril-admin/release-paths.json
```

Выход — JSON `{files:{path:sha256_or_null},configBefore:{nginx,authEnv,adminEnv},durationsBefore}`.
Содержимое файлов и пользовательские данные не выводятся. Сборщик переносит
эти значения в `before`, `configBefore` и `durations.before`, вычисляет SHA256
каждого payload и durations. Для каждой новой сборки перечитать серверные хеши.

## Offline зависимости

Отдельный ZIP `production-dependencies.zip` содержит только проверенные
production JS-зависимости из локального `npm ci` по тому же package-lock.
Внутри `dependencies-manifest.json`:

```json
{"version":1,"packageLockSha256":"sha256 of payload backend/package-lock.json","files":{"pg/package.json":"sha256","web-push/package.json":"sha256"}}
```

Пути `files` отсчитываются от **node_modules**, без префикса `node_modules/`.
ZIP содержит эти пути напрямую и manifest, никаких каталогов или bin-shim.
Размер ZIP 20 MB, распаковка 40 MB, файл 10 MB, максимум 4000 записей.
Сверяются внешний SHA256, хеш lockfile, каждый путь/хеш. Запрещены hidden-пути,
dev-пакеты, native/executable расширения, симлинки и пакеты с install scripts.
Lockfile должен содержать web-push 4.x. Локальная/серверная PG QA оркестратора
должна использовать тот же архив, подтверждая совместимость с Linux/Node24.
Это заменяет npm-runner.zip; publisher не требует npm/helper на сервере.

## Preflight и apply

```sh
sudo -n python3 /home/webpril-admin/publish-stars.py /home/webpril-admin/stars-release.zip --dependencies /home/webpril-admin/production-dependencies.zip --dependencies-sha256 ACTUAL_64_HEX
sudo -n python3 /home/webpril-admin/publish-stars.py /home/webpril-admin/stars-release.zip --dependencies /home/webpril-admin/production-dependencies.zip --dependencies-sha256 ACTUAL_64_HEX --apply
```

Preflight создаёт уникальную staging-папку `/opt/wep_pril/stars-release-<uuid>`.
Если runtime-каталог `/opt/wep_pril/backend/content` отсутствует, создаёт его
до остановки сервисов с root:root и явным chmod 0755 (независимо от umask).
Другие отсутствующие runtime-каталоги не создаёт. Все используемые runtime
parents должны быть без симлинков, принадлежать root и быть доступны на
чтение/проход обоим runtime-пользователям; существующий content проверяется
строго на root:root 0755, без автоматической смены его прав.
Проверяет allowlist, пути и симлинки, SHA256 и отсутствие конкурентных правок,
`/usr/local/bin/node --check` всех JS/MJS, здоровье двух сервисов и nginx.
Готовит root-owned node_modules и проверяет кандидат nginx в копии реального
главного nginx.conf с заменой только одного include целевого vhost. Другие
серверные блоки сохраняются. Неподдержанная структура nginx вызывает отказ,
а не попытку заменить весь конфиг. Режим preflight не меняет production-файлы,
схему, env, настройки аудитории, не останавливает сервисы.

Apply повторяет весь preflight. Затем получает свежую копию через действующий
backup.py и проверяет её восстановление verify-backup.py в изолированную БД.
Только после этого чисто останавливает wep-pril-auth и wep-pril. Сравнивает
старый ledger (count/sum/hash исходных столбцов до/после) без вывода строк.
Миграция в одной транзакции с owner role, lock_timeout 3s, statement_timeout
30s; исполняются только четыре новые миграции. GRANT — только новым таблицам
и двум новым последовательностям; прав на старые таблицы не расширяет.
weekly-poll.sql повторно не запускается. Additive-схема и legacy-прогресс
сохраняются при повторном запуске; баланс повторно не начисляется.

Сервисы стоят только во время транзакции/замены файлов/каталога зависимостей
и запуска/health. Stop ограничен 110 секундами, отдельные SQL statements —
30 секундами; фактический простой нужно измерить при выпуске.

Точечные изменения nginx: внешний `/api/auth/internal/` возвращает 404,
gamification/actions получает 16k, `/api/` передаёт Cookie и X-Webpril-Account.
auth.env получает AUTH_GAMIFICATION_ENABLED=true и путь durations. Существующие
VAPID-ключи/subject сохраняются; при их отсутствии web-push.generateVAPIDKeys()
запускается через именованный ESM export `generateVAPIDKeys` непривилегированным
wep-pril-auth в staging с минимальным env.
Ключи не выводятся/не сохраняются в логах и записываются только в auth.env.
Ни одного push/автоматической подписки. admin.env только проверяется по хешу.
Ни medicalApproved, ни budgetApproved, ни audience в БД publisher не меняет.
Импорт утверждённого источника и выбранные pilot-настройки — отдельное действие
оркестратора с реальным владельцем/основанием, без выдуманного approved_by.

## Повтор, отказ и откат

Внешние конфиги и все файлы повторно сравниваются перед остановкой и записью.
При полном совпадении payload/durations и требуемой конфигурации повторный
вызов также проверяет точный состав/хеши installed dependencies по offline ZIP
и неизменность admin.env. Возвращает STARS_ALREADY_INSTALLED без миграций,
генерации ключей и stop.
Частичное совпадение/дрейф вызывает отказ по исходным хешам.

Для отката автоматически сохраняются прежние code/env/nginx/durations,
приватная карта восстановления, путь DB-backup и прежний node_modules.
При ошибке publisher останавливает сервисы, проверяет ВСЕ затронутые файлы
перед восстановлением и сверяет хеши деревьев зависимостей. Совпадающие
файлы/каталоги восстанавливает, проверяет nginx, запускает оба сервиса и health.
Добавленная схема и новые пользовательские данные **остаются**. Production
pg_restore не выполняется: после новых записей слепое восстановление запрещено.
При конкурентной правке откат её не перезаписывает; выдаёт
ROLLBACK_INCOMPLETE_PRIVATE_STAGE_REQUIRED и оставляет приватный маркер
fix-forward-required. Сервисы в таком случае могут оставаться остановленными;
оператор сначала разбирает маркер и восстанавливает согласованный код вручную.
Staging не удаляется автоматически и хранится приватно до ревизии оператором.

## Локальная проверка

`python -B -m unittest discover -s deploy -p test_publish_stars.py -v`.
Unit-тесты полностью offline с временными файлами и mock сервисов/БД.
Не являются проверкой настоящего PostgreSQL, nginx или production.
