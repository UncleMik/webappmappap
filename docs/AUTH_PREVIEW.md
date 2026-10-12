# Вход и знакомство: предпросмотр 2026-10-12

Начало сценария: `login.html` → `register.html` → `onboarding.html`.
Восстановление: `forgot-password.html` → `reset-password.html`.

Выбран рисунок «Вариант 1 · Вход с паролем». Онбординг взят из демо https://legkie-rody-demo.mikkod.chatgpt.site/ после прохождения регистрации и просмотра обеих веток 2026-10-12.

`Фронт/assets/onboarding-motherhood.png` — исходная иллюстрация демо; карточки этапов показывают её левую и правую части без изменения файла.

`Фронт/assets/auth-mother.png` — иллюстрация, созданная встроенным imagegen. Промпт: «Soft delicate thin lavender line art of a mother lovingly holding her newborn with closed eyes, a few pale lilac leaves and tiny pale pink heart, pale pink and lilac backdrop blobs. Minimal elegant light line drawing matching the approved password login screen. No text, UI, borders or typography. Square composition, whole bust and leaves visible with spacious margin. Pale warm white #fcfafb background, pastel colors, calm childbirth school aesthetic, crisp clean lines.»

На экранах явно указан предпросмотр. Серверная авторизация, создание аккаунта, отправка писем и персонализация разделов не подключены. Пароли остаются только в полях формы. Имя для приветствия временно хранится в sessionStorage (`onboardingName`), ответы после завершения онбординга — в localStorage (`webpril.onboarding.preview.v1`). Данные не отправляются на сервер. Условия и политика не подготовлены; их флажок показан отключённым и не принимает юридического согласия.
