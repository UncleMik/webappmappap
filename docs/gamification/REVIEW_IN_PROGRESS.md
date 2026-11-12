# Архив замечаний промежуточной ревизии

Замечания ниже устранены и подтверждены итоговыми проверками; актуальный статус — [VERIFICATION.md](VERIFICATION.md). Ограничения старых рабочих тредов больше не действуют.

# Продолжение реализации: устранить остановку на сетевых тестах

Рабочая копия D:\Codex проекты\ВебПрил\output\stars-implementation-20261112. Только эта копия, explicit workdir. Не выполнять сетевые команды, npm install, SSH, браузер и тесты с HTTP: их выполняет основной тред. Не запрашивать эскалацию. Можно писать код, тесты, делать node --check, unit tests без сетевых подключений. Предыдущий исполнитель твоего направления остановлен на запросе сети и получил указание больше не редактировать. Не менять чужие файлы.

## wallet
- Довести все начисления/списания/доступ по IMPLEMENTATION и RULES, реальные settings.features/rewards/limits/prices/ai, не декоративные настройки. AI bank auth_stars_ai_credits, shared user FOR UPDATE перед кошельком/stock.
- Исправить legacy regression points.test: open mode outside pilot, отказ чужому аккаунту. Сетевые EACCES — окружение, но Missing expected rejection — настоящая ошибка.
- lifecycle не должен делать 251 UPDATE+42 SELECT при каждом asset request. Батч/однократная нормализация, один SELECT progress, группировка в памяти.
- Сделать weekProgress всех42 недель {week,total,completedCount,available,locked,purchased,rewardPending} по actual catalog, fifth material week25, статусы ранних и старых недель. Опубликовать внутренний метод для daily без nested withAccount.
- Перепроверить миграцию без удвоения и rerun после нового аккаунта; первое время launch marker неизменное; старые права временно в legacy review. Admin добавляет owner-only review resolution, нужны preserved weeks и audit. Публикация не твоя.
- Клуб root уже поправил FOR UPDATE OF u при sending. Проверить порядок блокировок points + poll. Полное голосование 20 сразу,10большинству при закрытии, tie и старые уже голосовавшие/settlement не удваиваются. Новые опросы по понедельникам10МСК до18воскресенья, источник 8+4, не заменять действующий опрос с голосами.
- Paid course duration manifest делает root; catalog.courseVideos(lessonId) готов. Проверить каждый required video, не только те, у которых url неnull; закрытый/неподдержанный ролик не делает урок завершённым. Trusted manifests ключ blockIndex:videoIndex и contenthash, показывать реальныйunsupported статус. Награда lessonId once.
- Добавить stars-core tests значимые все сценарии; HTTP тесты запустит root.

## access-ai
- Довести settings-driven quota, reserve/refund, фото/файл2. Старый pending запрос безreservation должен приfailed вернуть его старыйfreeрасход, не потеряться. Старыйspentнеобнулять.
- Date.now context может Date; Number(newDate(now)) перед arithmetic, не Date+number string.
- HTTP routes/gates all endpoints direct/list/bulk/video+HEAD/Lara; currentweek floor(days/7)clamp совпадает UI. PDR +/-14 от первоначальной, через переключенияэтапа не обходится.
- Standalone article server не должен создавать полный runtime: узкий localhost auth context endpoint с Cookie и X-Webpril-Account, failclosed, краткийpolicyбезбаланса. Настройку root интегрирует, опиши вhandoff.
- Реализовать ai-urgent.mjs и тесты по urgent_help_source точному экрану+триггерам+исключениям 2585–2607. Только утверждённые medical тексты. Каждое новое сообщение проверяется, бесплатнаястатичнаяподсказка, обычный запрос с явнымcontinue отдельноreserve идемпотентно. Не менять удалённуюЛару произвольно. HTTP/frontendcontract вhandoff.
- Main уже подключает createStarsAi({pool,settings}), createAiChat({starsAi,starsAccess,settings,...}), HTTP stars/starsAccess/gamification/gamificationNotifications. Обнови точные параметры если надо.
- Добавить собственные stars-ai/stars-access/urgent тесты, localhost-tests запускаетroot.

## admin-notifications
- Завершить owner-only UI и методы: settings,content,approval,audit,notifications,consent. Сейчас web-push не установлен из-за childnetwork; root установит нужную зависимость. Не повторяй npm/сетевые действия, пишикод.
- Settings bounds согласовать с HTTP и AI SQL (used<=30), не сохранять 10000 для неподдержанныхнастроек. Все фактически должны влиять на поведение. На rollout gate medical и AIbudget отдельные доказательства, no editor role expansion.
- Source draft visibility добавлена в state через basecatalog: подтвердить редактированиеоткрывает42писем126вопросов идругиепакеты, draft edit immediatelysuppresses published.
- Legacy owner-only resolve review для конкретного user, preserveexplicitweeks, audit. Общую legacy=true нельзя оставить какбезусловныйпостоянныйдоступ.
- Добавить owner aggregates: dailyvisits/active days/completedmaterials/weeks/spends/AIunits/pushoptout. auth_gamification_visits(user_id,moscow_day)unique minimal; daily трэд ожидает API. D1/D7/D30 exactreturns only maturecohorts, insufficientData иначе. Покупкикурсов/provideractualcost безисточника невыдумывать.
- notifications.syncPreferences existscanonicalbabyPause; убрать расхождениепаузы приизмененииизnotifications prefs vsdaily. profile.stage/mother прекращаетpregnancy nudges; capsule notification послеbirth должнаработать(сейчас blanketbaby_related hides it). Пауза капсулу скрывает.
- Проверь отправку: последний check consent/pause перед networkoutbound, одинlocalday, quiet21–09minimum, failed/ambiguous неслепойretry, никакого productionpush приразработке. scheduleNotifications делает daily, mainrootподключает.
- subscribeendpoint allowlist реальныхpushproviders, не SSRF arbitraryhttps; безопасныйurl/worker. Тексты изdraft неочерёдь. Исправление медтекста должноотозвать queuedстаруюверсию, хранить contentId+revision иcheckнаsend.
- Own meaningfultests, без сетевыхпрогонов. Main подключает фабрики поhandoff; configenvAUTH_GAMIFICATION_ENABLED иGAMIFICATION_PUSH_* готов.
