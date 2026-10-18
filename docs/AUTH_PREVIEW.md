# Вход и знакомство: предпросмотр 2026-10-12

Обновление 17 октября: для рабочего входа утверждён одноразовый код на email.
Иллюстрация и стиль сохранены; `login.html` использует новый сценарий,
а `register.html`, `forgot-password.html` и `reset-password.html` ведут на него.
Серверная реализация подготовлена; PostgreSQL, Unisender и отдельный ключ
GetCourse подключены и отдельно проверены 17–18 октября. Служба входа отвечает
через Nginx на домене приложения, публичная регистрация пока выключена
(`AUTH_ENABLED=false`, проверен ответ `503 auth_unavailable`); полный вход
на HTTPS не пройден. Подготовка отдельных
писем и подписок GetCourse описана в плане регистрации. Метки новой карточки
и снятие двух email-подписок проверены; обычное приветствие требует одобрения
шаблона ответственным школы. Это ещё не означает готовность входа.
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
