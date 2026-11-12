# Daily — реализация завершена, готово к общей интеграции

> Актуальный финал дополнительных задач: source import + presentation реализованы. Общий `node --test backend/test/gamification.test.mjs backend/test/stars-source-import.test.mjs backend/test/stars-catalog.test.mjs`: **30/30 pass, 0 fail** (23 daily,5 import,2 catalog), PGlite helper. Production, сеть и Git не менялись. Все source hints остаются исходными в body; только runtime подставляет реальные бизнесовые числа. Импорт для реального владельца запускает root отдельно через dry-run/CLI ниже.


Рабочая копия: D:\Codex проекты\ВебПрил\output\stars-implementation-20261112. Изменены только закреплённые daily файлы, commit/push/deploy не выполнялись.

## Файлы
- backend/auth/gamification.mjs
- backend/auth/gamification-content.mjs
- backend/auth/gamification-catalog.json
- backend/auth/gamification-migration.sql
- backend/test/gamification.test.mjs
- docs/gamification/handoffs/daily.md
Первичные тексты backend/content/gamification-source.json не изменены и не утверждены автоматически.

## Подключение
`createGamification({pool,service,stars,settings,catalog,notifications,clock})` возвращает `state(token,account)`, `action(token,account,body)`, `preferences(token,account,body)`, `letters(token,account)`, `notifyMaterialComplete(client,context,{week,weekComplete})`, `scheduleNotifications(options)`.
HTTP: GET /api/auth/gamification -> state; POST /actions -> action; POST /preferences -> preferences; GET /letters -> letters. HTTP wiring — access-ai, main/timer/migrate — оркестратор.
Все пользовательские вызовы идут через stars.withAccount, с серверной сессией/аккаунтом и общим wallet lock. Собственного баланса нет. Настройки читаются settings.get(client), без вложенного pool/транзакции. Порядок миграций: прежние points + stars + gamification-admin, затем gamification-migration.sql. Последняя добавляет state, actions и launch; SQL повторно применим.

## JSON состояния
`{accountId,enabled,dailyEnabled,tier,currentWeek,pregnancyDay,wallet,today,weeks,features,preferences,letters,quests,checklists,capsule,streak,settings,firstKick,kicks}`.
- enabled = global enabled && features.stars; dailyEnabled = enabled && features.daily. При daily=false кошелёк, купленные недели, письма и сохранённая капсула остаются, today=null, ежедневные действия закрыты.
- today: {day:1..7,checkin,reply,surprise,surpriseOpened,reveal,question,questions,care,urgent,offerCourse,recommendations}. Несуществующая карточка null. pregnancyDay — дни беременности, currentWeek совпадает с profile-dates.js floor(days/7), clamp1..42.
- weeks: все42 {week,available,purchased,locked,completedCount,total,completed,rewardPending,letter}. Счётчики из актуального inventory и общего progress, включая пять материалов 25-й недели. Закрытая неделя не требует пересдачи после пополнения каталога. UI замки только при features.weekLocks; legacy/purchased права сохраняются.
- question: {id,kind,week,prompt,options,answered}; только после ответа добавляются answer,explanation,selected,correct,article:{id,kind,week}|null. Ссылка только на доступную текущую/прошлую статью. Неотвеченные вопросы и будущие карточки ответов не раскрывают. guess_size заменяет вопрос2 в день3, вопрос2 переходит на день7: четыре попытки за неделю. Нет пригодных measurements — обычный вопрос2. 41–42 вопросы остаются резервом.
- letters: [{week,text}], только выданные + опубликованные; неделя40 выдаёт письмо независимо от кольца, без второго бонуса. Основной источник выдачи — auth_stars_weeks; ранняя завершённая неделя ждёт срока. Триместры начисляет только wallet.
- checklists: {bag:[{id,text,conditional,status,note}],doctor:[...]}. Сумка и bag-квест имеют одну награду quest/bag при 80% применимых пунктов, na только условным. Доктор хранит ответы без наград.
- capsule: {saved,opened,text?}. До открытия текст не возвращается; до открытия можно удалить. Открытие через календарный месяц от profile.birthDate, с корректным последним днём месяца. Без даты/при quiet/babyPause ждёт. Сохранённая капсула видна и после отключения конкретной игры/после родов, пауза скрывает. Текст capsule_save не остаётся в dedupe журнале: хранится SHA256.
- preferences: {quiet,babyPause,interests,timezone,postpartum,birthDate}. Последние2 вычислены из auth_users.profile.stage/birthDate и не принимаются в preferences: frontend меняет этап через имеющийся профиль.
- settings только публичные: rewards,limits,prices,ai,medicalApproved,aiBudgetApproved,features {peekNextWeek,aiPacks,capsule}, уже с учётом текущей возможности.

## POST действия
Всегда {type,requestId,...}; requestId 8–100 символов a-zA-Z0-9_- (UUID подходит). Лишние поля отвергаются. Суммы клиента не принимаются.
- checkin {mood:good|calm|tired|anxious|unwell,tags?:['кровь'|'сильная боль'|'малыш затих'|'подтекание']}
- surprise {}
- game_reveal {format:scratch|flip|choose,choice?:0|1|2}
- myth_answer {questionId,answer:index}
- quest_done {questId}
- checklist_update {list:bag|doctor,itemId,status:todo|done|na,note?:string<=2000}
- first_kick {}, kick_record {}
- capsule_save {text:string<=2000}, capsule_delete {}
- feature_hint_seen {feature} — максимум одна показанная новинка за день.
Возврат {ok:true,reward,result,state,duplicate?}. Точный повтор requestId безопасен; иной payload с тем же ID -> request_conflict. Новый requestId для уже оплаченного события возвращает actualAmount=0,duplicate=true,previousAmount. Прежние выданные медицинские результаты при replay заново проверяют текущую публикацию; draft-edit не позволяет получить старый ответ/срочный экран через повтор.

## Подборка и содержание
`loadGamificationCatalog()` -> исходный draft объект. `loadGamificationCatalog({pool})` -> async catalog(context,client), объединяющий gamification_content по стабильному id в той же транзакции. main уже оборачивает его catalog.daily с живым каталогом. DB status/medical/approval/evidence сильнее любых полей body; draft правка подавляет прежнюю запись. Публикация медицинского item требует status=published + item.medicalApproved + глобальный medicalApproved. Медицинские черновики не включаются одним enabled.
Нормализованы126 мифов,42 письма, care/ideas/practices/replies, расписание18 возможностей, календарные квесты и оба списка, weekly исходные тексты и словарь тегов. Срок/стаж, интервал новинок >=3дней, cutoff новых игр37, firstkick16–24, kicks28+, bag32+, doctor35+ соблюдены. Карточки пула не повторяются до исчерпания доступного триместра, повторная идея заменяется заботой. День6 выбирает доступное практическое видео, иначе утверждённый пул. День7 собирает реальные счётчики и начисления, без фиксированного «6».
Inventory: полный {kind,id,week,title?,tags?} можно передать cat.inventory, доступные рекомендации — cat.materials. state при отсутствии inventory берёт внутренний stars.materials(ctx) только для локального каталога; worker этого fallback не вызывает. Автотеги по точному словарю source, максимум3; ручные tags сильнее. Рекомендации только текущая + максимум2 прошлой недели, сначала непройденные/интересы. При тревоге/усталости/недомогании только подходящие теги, при отсутствии — care без искусственной ссылки; offerCourse=false для anxious/unwell. Baby pause скрывает baby карточки, письма, игры, рекомендации и капсулу.
Даты разделены: env.day=YYYY-MM-DD по Москве для ledger/checkins/капсулы; env.personalDay=1..7 для расписания. SELECT first_day::text исключает timezone-сдвиг node-pg DATE. Старым пользователям стаж с auth_gamification_launch, новым — с более поздней даты создания. До включения стаж не стартует. Main может вставить launch timestamp при включении.

## Срочная помощь
Mood alone не трактуется как симптом. Необязательные checkin.tags сверяются чистым matchesUrgent из access-ai и ТОЛЬКО утверждённым urgent-help из БД; чтение в текущей транзакции, без nested evaluate/pool. Тот же source/evidence/global medical gate, что в Ларе. Возврат result.urgent и today.urgent {contentId,revision,title,body,reassurance,actions,free:true}. Новая тревожная отметка проверяется каждый раз; draft и отозванная редакция не выдаются даже при replay. AI, квота и платный запрос не вызываются. Frontend должен показать этот статичный экран при наличии; произвольного нового медицинского ответа нет.

## Пауза и уведомления
notifications.syncPreferences(client,{userId,babyPause,timezone,types?}) вызывается в той же транзакции. Имеющийся opt-out до первого daily визита наследуется из notification preferences. Quiet независимо хранится: на включении сохраняет прежние8 типов и отключает их, на выключении восстанавливает. Notifications должен дополнительно учитывать daily quiet при прямой правке типов, чтобы не обойти паузу.
state при enabled идемпотентно пишет auth_gamification_visits(user_id,moscow_day); таблица admin уже добавлена. Никаких личных текстов в метриках. last_visit_at обновляется только при настоящем state визите; scheduler посещений не создаёт.

`await gamification.scheduleNotifications({limit:100,afterUserId:null}) -> {processed,nextCursor}`: закрытый internal hook, НЕ HTTP. Main проходит страницы до nextCursor=null раз в5мин, затем вызывает notifications.processQueue(). Только ранее enrolled и pushEnabled=true, без quiet/babyPause. Lock order user UPDATE -> wallet advisory -> wallet row -> daily. Не вызывает service.session/GetCourse/stars.contextFor/stars.materials; не начисляет наград. Catalog.daily в main использует локальный SQLite и125 видео, что подходит. События idempotent: new-week-{week},quest-{questId},almost-{week},daily-{YYYY-MM-DD},capsule. Приоритет/одинpush/тихиечасы/проверку подписки/сессии выполняет notifications. Медицинский текст в generic уведомления не вкладывается. После родов только личная капсула; capsule babyRelated=false, но babyPause всё равно скрывает её. Начисления сами событий не создают. Production push не отправлялись.

## Проверки и остаток интеграции
Финальный полный прогон `node --test backend/test/gamification.test.mjs backend/test/stars-catalog.test.mjs`: 22/22 pass, 0 fail (20 daily + 2 catalog). После добавления сохранения выбора игровых карточек дополнительно пройдены 3/3 targeted (`scratch flip|real root catalog|selected audience`). node --check обоих .mjs и git diff --check закреплённых файлов — успешно.
Проверяется настоящий createStars + PostgreSQL SQL через PGlite (сериализованный testPool), НЕ permissive fake credit. Конкуренция/нагрузка настоящего PostgreSQL, production и браузер не заявлены проверенными. Main связывает маршруты/таймер и выполняет общую ревизию/публикацию. Пользователь прямо подтвердил, что тексты последнего документа утверждены врачом. Root проведёт точные исходные тексты, включая urgent-help, через штатный approval с owner/evidence/source hash; будущая редактура по-прежнему draft. AI бюджет этим не утверждён. Никаких повторных вопросов пользователю о медутверждении.

## Audience rollout
Свежие settings.get(client) в load применяются через экспорт admin `forGamificationUser(config,userId)`; c.settings больше не обходится общими flags. Scheduler применяет тот же helper для каждого userId и не создаёт события вне выбранной аудитории. Использован namespace import, чтобы отсутствие ещё не дописанного экспорта не ломало plain-config unit tests; если audience уже есть, а helper отсутствует, daily fail closed. Конфиги без audience сохраняют прежнее поведение. Ни список pilot IDs, ни audience не выдаются в public state.settings.

Дополнительно UI weeks.locked и рекомендации сохраняют ctx.preservedWeeks после owner resolve-legacy. Метаданные доступных cat.materials объединяются с полным безтекстовым cat.inventory: кольцо знает все цели, а практика/подборка сохраняет заголовки и теги только разрешённых материалов.

Интеграционная ревизия root закрыта: regression `real root catalog...` использует настоящий createStarsCatalog + SQLite с опубликованными текущей/будущей статьями,125видео, настоящим createStars/PGlite. Проверены непустые заголовки и mood-теги в recommendations, отсутствие future title в JSON, preserved week24 остаётся открытой при включённых замках, week25 закрыта. Targeted 3/3 pass (real root catalog, care pool, selected audience). Metadata объединяется только для cat.materials.accessible===true.

Финальное дополнение: today.reveal={format:scratch|flip|choose,choice?:0|1|2} сохраняется после открытия; выбранную карточку нельзя перебрать новым requestId в тот же день, повтор не даёт новую награду. Все21 daily test cases +2 catalog cases проверены указанными full/targeted прогонами; ошибок нет. Исходники после этого зафиксированы по составу работы, root может запускать общую интеграционную проверку. Handoff полностью актуален, незавершённых исходников daily нет. Публикация, браузер и реальная нагрузка PostgreSQL остаются общей интеграцией.

## Дополнение presentation — реализовано и проверено
state.presentation={hint:null|{id,feature,text},celebration:null|{eventId,kind,title,body}}. hints — 16 исходных feature_hints_source, отдельные id hint-{feature}, проходят обычный DB approval loader/import. Runtime меняет только бизнесовые числа из settings; week_ring говорит «все материалы недели».
action feature_hint_seen {feature} хранит навсегда seenHints + hintDays (не более1/МСКдень), не начисляет награду. Новый action celebration_seen {eventId:string} валидирует реальный собственный ledger welcome/week_complete/trimester_complete; хранит seenCelebrations и серверный sessionHash→eventId, максимум1 на реальный вход, без награды. Frontend перед показом дополнительно использует notifications/presentation для единого UI лимита. Baby-themed celebrations скрыты в babyPause/mother; обычное wallet welcome остаётся. Реализовано; проверки постоянных отметок, дневного лимита и реальной серверной сессии пройдены.

## Source import — готовая отдельная функция
Новые файлы stars-source-import.mjs и stars-source-import.test.mjs. Экспорт importApprovedStarsSource({pool,ownerEmail,evidence,sourceSha256,dryRun=false}). SHA256 — байты backend/content/gamification-source.json, НЕ source.source.sha256 (это DOCX). ownerEmail строго из приватного ADMIN_OWNER_EMAIL; актор ищется по реальному email в auth_users, без UUID/сессии/HTTP.
Привилегированный CLI внутри уже загруженного trusted runtime env: `node backend/auth/stars-source-import.mjs --dry-run`, затем тот же вызов без --dry-run. Нужны AUTH_DATABASE_URL, ADMIN_OWNER_EMAIL, STARS_SOURCE_SHA256 (заранее сверенный), STARS_SOURCE_EVIDENCE (фактическое подтверждение пользователя). Не передавать секреты аргументами и не печатать env. CLI печатает только счётчики/хеши/dryRun/medicalGateChange, ошибку только code. Функция сама владеет BEGIN/COMMIT/ROLLBACK; не оборачивать другим pool transaction.
Предварительно проверяет все существующие body/kind/medical, конфликт сохраняет чужую правку и отменяет всё. Новые записи проходят draft→approved + два audit, точные существующие draft только approve без повышения revision. Повтор approved не меняет revision/аудит. enabled/audience/features/ai_budget не трогает, только medical_approved=true с audit. Отдельный source_imported audit сохраняет source JSON hash, DOCX hash, semantic/file catalog hashes и document/reused IDs. weekly/quests имеют отдельное evidence «Повторное использование действующих опубликованных материалов школы, без изменения содержания», без приписывания врачебному DOCX approval. Каталог DOCX сверяется с normalizer(source), изменённый catalog не принимается. Каталог импорта — 422 записи: 351 из DOCX (включая urgent-help и16hints) и71 повторно используемая (42weekly +29quests).

### Финальные результаты новых задач
- `stars-source-import.test.mjs`: 5/5 pass; dry-run без записей;422 точные записи с actualowner; неизменность enabled/audience/aiBudget; mismatch/ownerabsent/modifieddraft; поздний SQL-сбой откатывает все422; повтор не меняет аудит/ревизии; штатная admin-правка снимает approval; актуальный loader публикует16hints и urgent только после gate.
- `presentation.hint` и `presentation.celebration` готовы frontend. Подсказки: id `hint-{feature}`, постоянные seenHints +1/МСКдень; праздники: actualledger IDs, фактическая сумма, seenCelebrations +1/серверный sessionHash. Неподтверждённые/чужие события не принимаются, награды нет. Новая сессия корректно имитируется в тесте с отзывом старой по действующему one-session правилу. Baby-themed праздники и hints скрыты при паузе/после родов; welcome допускается.
- `celebration_seen` payload `{type,requestId,eventId:string}`; eventId — строка из presentation.celebration; frontend перед показом использует notifications/presentation, после показа подтверждает daily action. Для hint после показа — feature_hint_seen. Серверные лимиты дополнительно защищают от обхода клиентского sessionId.
- Публичный JSON не содержит приватный sessionHash, source audience или списки просмотренных событий.
- Прочитанный и проверенный SHA256 **самого JSON**: `36a6eaf76c8a323f73c68d4ac62864be543b782e9aba2f3518a557134f84de2e`. Root сверяет его перед передачей STARS_SOURCE_SHA256; исходный DOCX hash хранится отдельно в source metadata и proof audit.
- Проверка синтаксиса source importer/daily/content и diff-check выполнены. Новых схем для импорта/presentation не требуется: существующий JSON state и audit. Никакого реального импорта или выпуска из этого треда.
