# Release handoff

Владелец: тред безопасного publisher. Изменены только:

- deploy/publish-stars.py
- deploy/test_publish_stars.py
- docs/gamification/RELEASE.md
- docs/gamification/handoffs/release.md

Контракт сборки/inspect/preflight/apply полностью в RELEASE.md. Важные точки:

- Используется offline production-dependencies.zip, не npm-runner.
- Зависимости в ZIP: pg/... и web-push/... без префикса node_modules/.
- `--dependencies-sha256` обязателен; packageLockSha256 привязан к payload lock.
- Release manifest: revision/files/configBefore/durations; другие поля запрещены.
- Внутри release ZIP: manifest.json, course-durations.json, payload/<repo-path>.
- `--inspect paths.json` печатает только server before hashes, configBefore и durationsBefore.
- Durations строго version/rows; 1145 строк lessonId/videoKey/contentHash/durationMs/provider.
  Два неизвестных видео не включать; URL никогда не передавать.
- Обязательны 4 migration SQL и package*.json; весь runtime-набор определяет root.
- Пилот/medical/source import publisher не делает, disabled/selected empty сохраняет.
- Подготовка dependencies и кандидат nginx завершаются до stop.
- Backup+restore действующими server helpers до schema; ledger count/sum/hash до/после.
- Новая схема в bounded transaction, grants только новым таблицам/sequence.
- Nginx patch сохраняет остальной настоящий vhost; main nginx.conf только копируется.
- Rollback code/env/nginx/dependencies/durations под concurrent checks; никакого DB restore.

Проверки: `python -B -m unittest discover -s deploy -p test_publish_stars.py -v`.
После замечаний ревизии root исправлены NODE=/usr/local/bin/node,
именованный ESM import generateVAPIDKeys из web-push 4, подготовка
backend/content root:root0755 до stop с проверкой runtime parents.
Добавлен реальный локальный smoke генерации VAPID (ключи только в памяти,
без вывода), тест подготовки отсутствующего content parent.
Финальный прогон: 20 tests, 19 passed, 1 skipped (Windows запрещает
unprivileged symlink). Проверены allowlist/traversal/admin mapping, ZIP/JSON
manifest/checksum, nginx точечная правка и повтор, env сохранение ключей,
durations без URL/дублей/неизвестных длительностей, offline dependency outer
hash/lock hash/dev/native/traversal, повтор с drift dependencies, 4 migration
SQL без старых GRANT, полный precheck отката, сбой rename, сбой nginx с
восстановлением code/dependencies без pg_restore, backup failure до stop,
изменение ledger до любых записей приложения, inspect без выдачи секретов.
Изначальные ошибки временного sandbox-каталога, порядка env и фикстуры CRLF
исправлены до финального прогона; тестовые файлы создаются внутри workspace.

Реальные ограничения для ревизии root: только локальные unit; ни SSH, ни сервер,
ни npm, ни commit/push не выполнялись. Нужны настоящий PG harness с тем же
offline bundle, server preflight, измерение простоя и post-release QA сценариев.
Publisher health проверяет loopback auth session, article API health и systemd,
не моделирует вход владельца/покупку/игровые действия.
