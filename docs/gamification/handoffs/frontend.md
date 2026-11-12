# Frontend — выполнено 12 ноября 2026

Рабочая копия: `D:\Codex проекты\ВебПрил\output\stars-implementation-20261112`. Только пользовательские файлы `Фронт/` и собственные `tools/test-gamification-ui*`. Основная dirty папка, серверные исходники, admin/, push-worker.js, push-subscription.js, Git/production не изменялись этим тредом. Начальный контракт был записан до реализации и проверен через Get-Item.

## Реализованный контракт

`Фронт/gamification-api.js` — единый клиент с X-Webpril-Account, проверкой поколения/аккаунта, сбросом при завершении сессии. Без сохранения личного состояния в browser storage. Повтор мутации после сетевой ошибки использует тот же requestId; параллельный одинаковый запрос объединяется. Preferences — идемпотентный patch без requestId (реальный backend не принимает его).

- GET /api/auth/gamification + /stars объединяются. Кошелёк работает и без ежедневной игры. Серверные features/public settings являются единственным источником видимости и цен; explicit false не обходится fallback.
- POST /gamification/actions: checkin, surprise, myth_answer, quest_done, checklist_update, first_kick, kick_record, capsule_save, capsule_delete, game_reveal. stage/birthDate меняются только существующим профилем.
- POST /gamification/preferences; GET /gamification/letters поддерживается клиентом, коллекция также использует уже выданные state.letters.
- POST /stars/purchase kind peek_next_week/ai_pack; клиент не передаёт цену/награду. Перед списанием — конкретная цена, результат и баланс после покупки. Неделя предлагается **только при server weekProgress.locked=true**, никогда legacy/preserved/already available. Пакеты учитывают текущую quota, запас и дневной предел. Число покупок считается по фактической полной истории текущего серверного московского дня; предложение скрывается после предела. Сбой загрузки условий не показывает покупку вслепую.
- GET /points?before — полная история с cursor, отрицательными суммами, подписями и временем МСК. Backend wallet уже добавил pagination; старое замечание про limit20 закрыто.
- GET /ai/quota использует totalRemaining/freeRemaining/paidRemaining/paidDailyRemaining/maximum. Фото/файл — 2 единицы; статичный urgent экран бесплатен даже при нулевом запасе. Продолжение — те же requestId/text/file/conversationId плюс signed urgentContinue, не boolean. Каждый новый вопрос снова проверяется. Тексты исключительно из approved server payload.
- Notifications: «Для вас», read только видимых уведомлений, никакого чтения чатов при открытии колокольчика. Начисления не зажигают red dot. WebprilPush.enable/disable подключён с injectable account-bound API; разрешение только по явному нажатию. Типы/quiet/babyPause/timezone подключены к действующим API. Push-файлы другого владельца не редактировались.

## Пользовательский интерфейс

`gamification.js` + `gamification.css`: Today/checkin/reply/care/surprise/questions/guess-size, реальное кольцо completedCount/total, wallet/purchases/history/instruction, коллекция писем/share (native share, fallback copy), квесты, bag/doctor checklists с условным «не относится» и заметками врачу, first kick/daily kick, sealed/open/delete capsule, настройки деликатности и уведомлений. Пустые/неутверждённые карточки не выводятся. Числа инструкции берутся из актуальных public settings; index.html обновлён в том же изменении.

Стирание — canvas/pointer capture с фактическим порогом покрытия плюс доступная кнопка. Flip — двухсторонняя карточка с реальным переворотом и reduced-motion. Choose — выбор одной из трёх карт. Все используют единственное серверное surprise-событие, без второй награды. Доступные форматы раскрываются по server features.

Рекомендации заменяют исходный набор через существующий articles-api renderer; дубликаты не добавляются. Канонические video IDs 001/002/003 переводятся в contractions-lesson/back-relief-video/birth-breathing-video, остальные в week-video-NNN. Пауза убирает baby content, письма, capsule/game/recommendations и передаётся сохранённым iframe-панелям. Старые закрытые недели не остаются на экране. Partial weekly JSON с полным календарём принимается; articles/weekly запросы отправляют account header и не применяют ответы прежнего аккаунта.

Интеграционные правки: app-navigation/entry HTML, ai.js/ai.css, articles-api/article.js/article-points, mom-week/baby-week, helpers (реальная запись шевеления вызывает kick_record), notifications, weekly-content-api/weekly-videos/weekly-video-player/video-points, course-lesson. Asset query версии обновлены.

## Видео

- `course-video-points.js`: каждый HTML5 ролик платного урока отправляет фактический video.played, разность уникальных интервалов, heartbeat10s, flush pause/end, сброс attempt при паузе панели/сессии. Независимые DOM изменения не создают запросы. Ключ — исходный blockIndex:videoIndex.
- `course-embed-points.js`: YouTube через официальный IFrame Player API (onStateChange/getCurrentTime); Rutube через player:changeState/currentTime/adStart/adEnd, проверяя origin + source. Не считает seek, повтор интервала, скрытую панель и известную рекламу. Таймер опрашивает media time, сам не является просмотром.
- POST /stars/course-video; только server course/access/manifest/contentHash разрешают начисление. unsupported/unverified safely stops reward tracking, просмотр остаётся доступен.
- Native weekly source JSON lookup отправляет X-Webpril-Account. src/poster/cover содержат единственный account UUID query, сравниваемый с живой сессией. Плеер сохраняет origin/path/hash проверку и сбрасывает старые media URLs при смене аккаунта. UUID — не токен и не право доступа.
- Документация providers: https://developers.google.com/youtube/iframe_api_reference и https://rutube.ru/info/embed/.

## Выполненные проверки

Все команды — с явным workdir этой копии, без локального веб-сервера/туннеля. Chrome headless через установленный Playwright и route fixtures; никакого обращения к production API.

1. `node tools/test-gamification-ui.mjs` — **320/390/500: все прошли**, pageerrors=[]; реальные wallet/daily/stars-ai domain-модули и отдельная PGlite, синтетические тексты. Checkin, question/answer, choose/flip/scratch gestures, ring, ledger pagination >20, letters, checklist, capsule save/delete, pause, 420px keyboard viewport/scroll/Escape, тот же requestId после transport failure, week purchase, две AI pack purchases и скрытие после предела, account swap во время запроса и session end.
2. `node tools/test-gamification-ui-ai.mjs` — **320/390/500: все прошли**, pageerrors=[]; quota/urgent API fixtures, same-request signed continuation, rescreen нового вопроса, клавиатура. Тестирует настоящий ai.js вместе с gamification header.
3. `node tools/test-gamification-ui-native.mjs` — **320/390/500: все прошли**; настоящий браузер воспроизвёл синтетический MP4, account query проверен для file/cover, реальные played ranges отправлены; при account swap src/poster/cover удалены. Тест генерирует свой двухсекундный MP4 через ffmpeg при отсутствии.
4. `node --test tools/test-gamification-ui-video.mjs` — **2/2 pass**: уникальные media intervals/seek/repeat/ad/hidden, documented provider URL parameters.
5. node --check для изменённых JS; git diff --check для owned frontend — проходят. Только штатное предупреждение LF→CRLF у ai.css; Node предупреждает о browser ES module без package type, тесты проходят, package.json не менялся.

Артефакты: `output/playwright/gamification/result.json`, `ai-result.json`, `native-result.json`, PNG на трёх ширинах. Визуально просмотрены Today320, keyboard320, urgent320. Старое падение ожидания фиксированной строки surprise устранено: тест читает фактическую surprise.text из реального daily.state. Fixture включает все необходимые AI миграции и явную синтетическую audience=all; production audience не менялась.

## Граница проверки / передача root

Работа подключена к реальным URL и согласованным backend форматам. Браузерные проверки используют перехват запросов: основной сценарий вызывает реальные domain-методы с PGlite; AI urgent — синтетический HTTP payload; native video — синтетические байты. Это не проверка опубликованного сервера, реальной внешней модели, телефона, реального push permission/delivery или live YouTube/Rutube потока. Live QA и запуск/публикация остаются root. В этой ветке не выполнялись commit/push/deploy/production writes.

Нужна финальная интеграционная ревизия владельца: применить весь порядок миграций/manifest, live HTTP/session/access/recovery, реальный курс с несколькими роликами и внешними providers, настоящий share/push на устройстве. Новых продуктовых вопросов или неподключённых frontend API по известным контрактам нет.

### Дополнительные завершающие проверки
- Последний main UI прогон также проверяет server ring `0 / 2`, отсутствие продажи следующей недели при legacy=true, preservedWeeks и weekLocks=false — на всех трёх ширинах.
- `node --test tools/test-gamification-ui-cache.mjs` — **1/1 pass**: account header у article index, запоздавший ответ прежнего аккаунта не меняет новый corpus; session-ended очищает index/library. Index reload после покупки и смены аккаунта не оставляет чужую подборку; late errors тоже не заменяют новое состояние. Weekly JSON дополнительно проверяет поколение после чтения body.
- Это последние изменения frontend; все известные контракты подключены. Изолированные статусы enabled=false не заменяются демонстрационными данными. Автоматические праздничные экраны не генерируются клиентом по произвольной сумме: события/приоритеты остаются серверными.

## Admin browser QA follow-up
Создан `tools/test-gamification-admin-ui.mjs`; только этот тест и handoff изменены для admin-задачи. Реальные index.html/panel.js/stars.js/ui.css, route handlers вызывают настоящий createGamificationAdmin из существующего SQL fixture/helper, изолированная PGlite, synthetic owner cookie + X-Webpril-Account. Без production, локального сервера, почты или push.

Первый полный прогон: 390 и1280 — по29 функциональных проверок прошли, pageerrors/APIerrors=[] и без горизонтального overflow. Pilot по имени/email и клавиатуре, settings и аудит actor/before-after, типизированный question/options/correct-answer, две версии с approval reset/reapproval, retained selection, readonly metadata, legacy preserved22+selected30/31 с аудитом, метрики D30 и missing sources, раскрытие аудита клавиатурой. Снимки `output/playwright/gamification-admin/`.

**Найден P2 (admin файлы не тронуты):** при редактировании текстов вариантов вопроса подписи option в выпадающем «Правильный ответ» остаются исходными до сохранения. В `question-390.png` поля уже «Синтетический вариант А/Б», а меню всё ещё «Вариант1: Правда / Вариант2: Миф». `Фронт/admin/stars.js`, ветка key==='answer' строит option из value.options лишь при render; edits reads[] записываются в body только по сохранению, подписки на option input нет. Владелец может выбрать ответ по устаревшей подписи. Добавлен явный assertion, не прерывающий остальные шаги; повторный прогон должен вернуть finding для обеих ширин до исправления владельцем. Решение — обновлять подписи answer dropdown при редактировании options, сохраняя выбранный индекс. Parent/root передаёт владельцу admin, я чужие файлы не меняю.

## Presentation и onboarding — реализовано
Предыдущее замечание про отсутствие автоматических presentation закрыто. `gamification.js` использует state.presentation и настоящий notifications/presentation claim, затем acknowledgement action. Подсказка — ненавязчивый aside с точным опубликованным текстом, feature_hint_seen хранится сервером навсегда. Праздник — отдельный modal по реальному ledger event + celebration_seen; сервер ограничивает actual session hash. Сумма не начисляется клиентом повторно. При показе праздника hint откладывается до следующего посещения Today.

Показ только на видимом Today. Во время любого другого dialog/urgent/мутации, quiet, babyPause или неподходящего postpartum popup не накладывается. Если окно открыли во время claim, зарезервированный показ ожидает закрытия; account/session change очищает очередь. Hints перепроверяют текущую feature/week. Native keyboard/Escape/reduced-motion сохраняются.

`tools/test-gamification-ui-presentation.mjs` — 320/390/500 pass, pageerrors=[]: celebration priority, hint defer, once/day + постоянный seen feature, разные реальные сессии, urgent/modal deferral, babyPause, реальный welcome/week/trimester event и отсутствие нового credit при показе. `presentation-result.json`, celebration/hint PNG в output/playwright/gamification. Основной fixture по умолчанию помечает seed presentation history просмотренной, чтобы welcome не прерывал независимые тесты.

`weekly-poll.js` теперь уважает server read.available/read.enabled даже при наличии старого poll, очищает UI при account/session/network error и отправляет account header. Assets index/club обновлены. `tools/test-gamification-ui-poll.mjs` — 6/6 (320/390/500 × Today/Club): новый пилот day0 hidden, day2 available, непилотный прежний сценарий сохранён, session reset, pageerrors=[]. Настоящий createWeeklyPoll + stars.pollAvailability/PGlite, без production. Club fixture открывает существующий events container, чтобы изолировать именно блок голосования.

Admin QA итог до исправления чужим владельцем: 2 ширины ×30 checks, по29 pass и один воспроизводимый P2 stale correct-answer labels; exit1 намеренно сохраняется до исправления stars.js. Все остальные шаги полного сценария выполняются после finding. См. output/playwright/gamification-admin/result.json и предыдущий блок handoff. Чужие admin-файлы не менялись.

## Финальная перепроверка после owner fix admin
Владелец/root исправил `admin/stars.js`: подписи correct-answer options обновляются по input вариантов, выбранный индекс сохраняется. Я admin-код не редактировал. Повтор `node tools/test-gamification-admin-ui.mjs` после этой правки: **390/1280 — по30/30 pass**, findings=[], pageErrors=[], apiErrors=[], exit0. Предыдущий P2 закрыт подтверждённым браузерным повтором. Снимки/result.json обновлены.

Одновременно повторены после integration presentation: основной UI **3/3 width pass**, presentation **3/3 width pass**, poll **6/6 page/width pass**, все pageerrors=[]. Последние артефакты: output/playwright/gamification/{result,presentation-result,poll-result}.json и output/playwright/gamification-admin/result.json. Scoped syntax/diff checks проходят. Системы production, почта, реальные push и чужие файлы не затронуты этим тредом.
