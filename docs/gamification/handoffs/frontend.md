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

## Срочное исправление Today header после production QA
Production не открывал и не менял. Исходный live screenshot изучен только как локальный файл output/verification/live-browser/inspection-320.png.

До CSS исправления расширенный regression воспроизвёл проблему с настоящим account-profile.js и именем «Проверка выпуска»: viewport/clientWidth320, scrollWidth343, badge.right343.156 (balance1124, поэтому шире production badge55). Это был ожидаемый падающий прогон, а не скрытый scroll overflow.

Минимальная правка только в Фронт/gamification.css: первый блок заголовка flex:1 1 0 + min-width:0; блок кнопок flex:0 0 auto с существующим компактным gap; приветствие переносится как обычный текст с overflow-wrap:anywhere, сердечко остаётся inline. Навигация, размеры кнопок, типографика и остальной дизайн не менялись. Для runtime публикации нужен только этот CSS файл; JS/HTML не изменялись.

В tools/test-gamification-ui.mjs подключён настоящий account-profile.js. Origin fixture — https://localhost (поддержанный кодом профильный guard), все запросы перехватываются без запуска сервера. Проверяются три имени на каждой ширине320/390/500: «Проверка выпуска», длинное имя с пробелами и длинное имя без пробелов. Имя приходит из session/profile и изменяется через настоящий profile:saved refresh, не подставляется вручную в DOM. После загрузки шрифтов проверяются clientWidth===scrollWidth, badge целиком внутри viewport, отсутствие наложения приветствия на кнопки, видимость сердечка. Снимки header-{width}-{1,2,3}.png, метрики headerLayouts входят в result.json. Визуально просмотрен самый длинный вариант320.

Commit/push/deploy остаются root; никаких production запросов, только route fixtures и локальные файлы.

Финальный прогон исправления: **3/3 ширины, 9/9 комбинаций имени**, основной сценарий целиком проходит, errors=[]. На320 px scrollWidth=clientWidth=320 для всех имён, badge.right=307.844; на390 —390/390,badge.right375.188; на500 —500/500,badge.right481. Это закрывает исходный mobile overflow в fixture с настоящей персонализацией. node --check и scoped diff --check проходят (только штатное LF→CRLF предупреждение CSS).

## Возврат структуры до геймификации — начальный контракт
Текущая задача от root: база main ac1979d, исходный layout9f591a35f459b340e932566c0ecd7cc3a7ef7771. При старте git status чистый. Backend, SSH/production, npm, commit/push не трогаю. Прочитаны применимые AGENTS и действующие решения; текущее прямое поручение пользователя отменяет новую inline структуру.

Фаза1: вернуть Today header notification → existing points button → real profile photo, прекратить runtime prepend новых блоков Today/Journey, вернуть исходную подборку cards/pictures/links из articles-api. Права, session/account isolation, server progress/ledger/purchases не откатывать. API механик остаётся подключён. Автоматические presentation временно приостановлены до согласования отдельного окна, чтобы не ack невидимые подсказки.
Фаза2 пока ждёт решения root о входе через баллы либо «Ещё». Новый вход и структуру окна до ответа не реализую; изучаю перенос существующих renderToday/renderProgress/renderTools/renderLetters/preferences в window.
Regression готовится как сравнение двух версий страниц с одинаковыми fixture данными на320/390/500, настоящим account-profile.js и успешным /profile-photo с реальным локальным фото (не пустой avatar SVG). Скрины и точные структурные проверки будут в output/playwright/gamification-layout-restore.

## 2026-11-12 — подтверждённый вход через прежнюю кнопку баллов
Пользователь прямо согласовал «Да, через кнопку баллов» (передано root). Фаза2 реализована: исходная `#points-trigger`, её SVG, label/balance и порядок колокольчик → баллы → фото сохранены. Открывается ровно прежний `#points-dialog`, без конкурирующего диалога и новой pill после аватара. Для пилота внутри находятся Баллы, Твой день (забота, игры, вопросы, персональные ссылки и прогресс), Мои дела (чеклисты/квесты/капсула), Письма, Настройки. Непилот получает прежнее содержимое этого же диалога.

Runtime prepend `.stars-shell` в Today/Journey/profile/baby удалён. Main Today и Journey возвращён к исходным блокам reference9f591a35f459b340e932566c0ecd7cc3a7ef7771; исходные карточки articles-api, картинки, unread-first, практика и широкий poll сохранены. Старое правило today.css, скрывающее первую статью после poll, не изменено. Новая геймификация больше не скрывает poll по своей day-feature: решает исходный weekly-poll.js и ответ backend. Server purchase/progress/rewards/access не откатывались. Заголовок сохраняет baseline отступы; минимальные flex/min-width/перенос имени защищают длинное персональное имя.

Presentation claim/ack и серверные лимиты сохранены, но claim начинается только после открытия окна. Hint и celebration — дочерние карточки внутри него. Второго modal и автоматического всплывания на главных страницах нет.

Адресные исправления после независимой ревизии root:
- `points.js` подписан на pilot snapshot: legacy async load/reset не изменяет общую кнопку/окно во владении пилота; поколение и accountId инвалидируются, выход из пилота запускает прежний fetch. Реальный уход со страницы/visibility/session-ended по-прежнему закрывает окно.
- `open()` проверяет version/account до и после pagination, затем присваивает quota/history; stale catch не показывает ошибку нового открытия.
- `gamification-api.js` очищает snapshot/retries/очередь и уведомляет UI при401, sign_in_required, account_changed и403 чтения защищённого state/wallet. Обычный403 покупки не приравнивается к выходу. `auth-client` сам такое событие не отправляет.

Runtime-файлы этого треда: Фронт/articles-api.js, gamification.js, gamification-api.js, gamification.css, points.js, index.html. В index только query нового points.js; cache-only изменения прочих HTML/app-navigation отменены по информации root о private,no-store. Backend/admin/production/SSH/commit/push этим тредом не менялись.

Новый tools/test-gamification-layout-restore.mjs читает полные baseline/current HTML+JS+CSS, ничего не вырезает из script. Все запросы перехвачены Playwright; только строка origin контентного transport переписана в памяти на localhost. Нет local server, туннеля или запросов production. Общие fixtures для baseline/current: session, personal, статьи, full42-week content, course offers/access, current poll. State/actions/ledger/checklist — настоящие сервисы в отдельном in-memory PGlite. JPEG берётся из tracked backend/test/fixtures/profile-edit-noise.jpg, предварительный ignored артефакт не требуется. Профиль реально грузит этот JPEG через /profile-photo и UUID photoVersion, проверяются naturalWidth и error→recovery.

Сравнение на320/390/500 с isMobile:true,hasTouch:true: точный состав/порядок блоков, заголовков, карточек, картинок/ссылок; геометрия заголовка и карточек в пределах1CSSpx (обычный перенос приветствия отличается на0.22px). Длинные имена и баланс121124 не переполняют экран, кнопки/фото не перекрываются. Journey→Today — настоящий app-navigation/iframe; frame выбирается по DOM#today, поскольку URL родителя тоже меняется. Искусственная сменаaccount безreload проверяется в существующей изолированной UI fixture, а не обходит реальный auth-gate полного shell.

Обновлён прежний tools/test-gamification-ui.mjs: весь прежний набор действий проходит через окно; сохранены checkin/question,3формата игры, ledger>20, letters, checklist, capsule save/delete, pause, keyboard420px, retry requestId, week purchase,2AI packs+limit, legacy/preserved/locks-off, account/session isolation. Добавлены stale quota открытия и pilot→nonpilot другогоaccount безreload. Full restore дополнительно держит старый legacy /points до checkin и проверяет новый баланс/открытое окно после его ответа, а401read без ручного session-ended очищает приватное окно и snapshot. Presentation regression теперь сначала доказывает отсутствие показа до клика, затем один прежний dialog, вложенные карточки, серверные once/day/session/seen ограничения, urgent deferral, babyPause и отсутствие нового credit.

Артефакты: output/playwright/gamification-layout-restore/{result.json,baseline-today-W.png,current-today-W.png,baseline-journey-W.png,current-journey-W.png,window-W.png,long-name-W.png}; W=320/390/500. Основной UI: output/playwright/gamification/result.json, header-*,keyboard-*.png; presentation-result.json,celebration-*,hint-*.png. Production/реальные устройства остаются проверкой root после release.

Финальные прогоны после всех адресных исправлений: `node tools/test-gamification-ui.mjs` —3/3 width,9/9name, errors=[]; `node tools/test-gamification-ui-presentation.mjs` —3/3width, errors=[]; `node tools/test-gamification-layout-restore.mjs` —3/3width, baseline/current+настоящийnavigation+race+401 pass. Node syntax для4затронутыхJS и scoped git diff --check —exit0. Все изменения остановлены; commit/push/publish выполняетroot.
