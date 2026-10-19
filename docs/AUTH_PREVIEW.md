# Вход и знакомство: предпросмотр 2026-10-12

Текущий статус на 19 октября: [постоянный публичный вход](AUTH_PUBLIC_ENABLE.md)
на Timeweb включён и проверен через рабочий HTTPS. Настоящий код Gmail,
вход в существующий аккаунт, сохранение после обновления и выход работают;
дубля GetCourse нет. Включён автозапуск, временных ограничений IP и таймера
закрытия нет. Лимит 500 писем в сутки и ссылка отписки сохранены.

Для рабочего входа используется одноразовый код на email. Иллюстрация
и стиль сохранены; `login.html` использует этот сценарий, а `register.html`,
`forgot-password.html` и `reset-password.html` ведут на него. Подключены
PostgreSQL, Unisender и отдельный ключ GetCourse. Обычное приветствие школы
работает через отдельный процесс с исключением метки приложения.
В профиль доставлены `profile.html` и `account-access.js`; блок аккаунта
и выход проверены. Предшествовавший [временный тест](AUTH_BROWSER_CHECK.md)
автоматически закрылся; его закрытый режим заменён постоянной активацией.
Онбординг ниже остаётся демонстрационным и не
служит подтверждением реального аккаунта или правовым основанием сбора ПДР.
Текущий статус: [план регистрации](План%20регистрации%20и%20входа.md).

Ниже — описание исторического предпросмотра с паролем, а не требования к
текущей серверной авторизации.

Начало сценария: `login.html` → `register.html` → `onboarding.html`.
Восстановление: `forgot-password.html` → `reset-password.html`.

Выбран рисунок «Вариант 1 · Вход с паролем». Онбординг взят из демо https://legkie-rody-demo.mikkod.chatgpt.site/ после прохождения регистрации и просмотра обеих веток 2026-10-12.

`Фронт/assets/onboarding-motherhood.png` — исходная иллюстрация демо; карточки этапов показывают её левую и правую части без изменения файла.

`Фронт/assets/auth-mother.png` — иллюстрация, созданная встроенным imagegen. Промпт: «Soft delicate thin lavender line art of a mother lovingly holding her newborn with closed eyes, a few pale lilac leaves and tiny pale pink heart, pale pink and lilac backdrop blobs. Minimal elegant light line drawing matching the approved password login screen. No text, UI, borders or typography. Square composition, whole bust and leaves visible with spacious margin. Pale warm white #fcfafb background, pastel colors, calm childbirth school aesthetic, crisp clean lines.»

На экранах явно указан предпросмотр. Серверная авторизация, создание аккаунта, отправка писем и персонализация разделов не подключены. Пароли остаются только в полях формы. Имя для приветствия временно хранится в sessionStorage (`onboardingName`), ответы после завершения онбординга — в localStorage (`webpril.onboarding.preview.v1`). Данные не отправляются на сервер. Условия и политика не подготовлены; их флажок показан отключённым и не принимает юридического согласия.
