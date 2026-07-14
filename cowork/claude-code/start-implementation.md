# Как стартовать реализацию проекта (Claude Code + Spec Kit + wiki)

> Операторский runbook: где что лежит, где открывать терминалы, начальные промты и их порядок. Правила работы для самого Claude Code — в `instructions.md`. Роадмап — в `../plan.md`.

## 0. Раскладка (важно) — репозиторий = папка проекта

Продуктовый репозиторий — это **`C:\Dev\crm-foundation\code\crm`**. Внутри него лежат и `CLAUDE.md`, и доки (`cowork/`), и код. Референс Chatwoot и дизайн-бейкофф лежат **снаружи** репо (на уровень выше).

```
C:\Dev\crm-foundation\code\crm\   ← РЕПО: git init здесь, Claude Code открывать здесь, это пушится/деплоится
  CLAUDE.md          ← роутер
  cowork/            ← доки/решения (source of truth)
  api/  web/         ← код (появятся в Phase 0)
  .gitignore
C:\Dev\crm-foundation\code\chatwoot\    ← Chatwoot-референс, ВНЕ репо (по пути ../chatwoot), read-only
C:\Dev\crm-foundation\code\design-lab\  ← дизайн-бейкофф, ВНЕ репо (../design-lab), одноразовый
C:\Dev\claude-obsidian\vaults\crm\      ← wiki проекта (память разработки)
```

- **Claude Code открывать в `C:\Dev\crm-foundation\code\crm`.** Тогда cwd = корень git-репо = там же `CLAUDE.md` и `cowork/`. Код пишется в этот же корень (`api/`, `web/`).
- **`specify` (Spec Kit) — тоже в `C:\Dev\crm-foundation\code\crm`**, чтобы `.specify/` и команды `/speckit.*` оказались там, где работает Claude Code.
- Chatwoot-референс из репо доступен как `../chatwoot` (он вне репо и не версионируется — это правильно).

## 1. Нужен ли Spec Kit, чтобы стартовать?

Нет, это **не блокер**. У нас уже есть `cowork/plan.md` с пунктами — Claude Code может работать по нему и без Spec Kit. Spec Kit — **опциональный слой** «спецификация → план → задачи → реализация», удобнее всего по одной фиче (brownfield). Рекомендация:

- **Phase 0–1 (каркас, инфра)** — делаем **напрямую по `plan.md`**, без Spec Kit (там нечего «специфицировать»).
- **Phase 2+ (модель данных, ядро, каналы, экраны)** — крупные фичи прогоняем **через Spec Kit**.
- **`constitution` (принципы) ставим один раз в начале** — она направляет все дальнейшие `/speckit`.

Не путать два `plan.md`: наш `cowork/plan.md` = общий роадмап; Spec Kit создаёт **свой** `plan.md`/`tasks.md` на каждую фичу в `specs/<feature>/`.

## 2. Разовая настройка (терминал в `C:\Dev\crm-foundation\code\crm`)

```bash
# 2.1 git — инициализировать в КОРНЕ репо (эту команду делаешь ты)
git init
#     .gitignore уже создан (node_modules/, dist/, .env, логи, coverage).
#     chatwoot и design-lab вне репо — игнорить не нужно.
git add . && git commit -m "docs: baseline architecture + plan"
#     затем создать пустой repo на GitHub и запушить (нужно для деплоя, ADR 0026).

# 2.2 установить Spec Kit CLI (взять последний тег со страницы Releases)
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@vX.Y.Z

# 2.3 инициализировать Spec Kit в репо (папка не пустая → --force)
specify init . --force --integration claude
```

После `init` в Claude Code появятся команды `/speckit.*` и папка `.specify/` (`memory/constitution.md`, `templates/`, `scripts/`).

## 3. Порядок работы и начальные промты

Открываешь **Claude Code в `C:\Dev\crm-foundation\code\crm`** и идёшь по шагам.

### Промт 0 — ориентация (код не пишем)
```
Прочитай ./CLAUDE.md, cowork/00-project-context.md и cowork/plan.md.
Кратко подтверди: наш стек, правила (definition of done из
cowork/claude-code/instructions.md) и назови следующий незакрытый пункт
plan.md. Код пока не пиши.
```

### Промт 1 — конституция (Spec Kit, один раз)
```
/speckit.constitution
Составь конституцию проекта из наших инвариантов:
- безопасность (cowork/security/README.md): tenant/account isolation,
  RBAC в policy-слое, SSRF-защита, no PII in logs, security-гейт;
- white-label (ADR 0028): бренд только через CSS-токены;
- перформанс-бюджеты (cowork/performance.md);
- модульный монолит (ADR 0024);
- definition of done (cowork/claude-code/instructions.md).
```

### Промты 2..N — Phase 0–1 напрямую по plan.md (по одному пункту)
```
Сделай ТОЛЬКО пункт 0.1 из cowork/plan.md (scaffold NestJS в ./api).
Соблюдай definition of done из cowork/claude-code/instructions.md:
код + тест (падает без изменения, проходит с ним) + зелёный прогон +
обнови статус пункта в plan.md. Отчитайся и остановись.
```
Повторяешь для 0.2 → 0.7, затем 1.1 → 1.5. Каждый раз меняешь номер. Один пункт — один шаг — проверил — дальше.

### Фичи (с Phase 2/4) — цикл Spec Kit на каждую фичу
```
/speckit.specify   <что строим: требования и истории, без техстека>
/speckit.clarify   <ответить на уточняющие вопросы>
/speckit.plan      Техстек из наших решений: NestJS + Prisma (Supabase),
                   Vue 3 + shadcn-vue, REST+SSE/WS, keyset-пагинация,
                   виртуализация списков.
/speckit.tasks
/speckit.analyze   (опц. — сверка spec/plan/tasks)
/speckit.implement Код только в этом репо, по инвариантам конституции.
```
После `implement` — синхронизируй статус пункта в `cowork/plan.md`.

## 4. Wiki (claude-obsidian) в процессе

- Во время кодинга **ничего делать не надо** — Claude Code сам подтянет `vaults/crm/wiki/hot.md`, когда нужен контекст истории (это прописано в `CLAUDE.md`, блок «Wiki Knowledge Base»).
- **После значимой сессии** зафиксируй память проекта:
```
Заведи заметку сессии в C:\Dev\claude-obsidian\vaults\crm (папка sessions/)
и добавь строку в wiki/log.md: что сделали, какие решения на практике,
какие грабли. ADR не копируй — ссылайся по номеру.
```
(Если установлен плагин claude-obsidian — это команда `/save`.)
- **Секреты в заметки не пишем** — только указатели (общий `wiki/references/credentials-and-accounts.md`).

## 5. Короткий чек-лист «первый день»
1. Терминал в `C:\Dev\crm-foundation\code\crm`.
2. `git init` + commit + push на GitHub; установить и `specify init` (§2).
3. Claude Code в этой же папке → Промт 0 (ориентация).
4. Промт 1 → конституция.
5. Промты по `plan.md` 0.1 … 1.5 (каркас + инфра), по одному.
6. Дальше фичи через `/speckit.*`.
7. После сессии — заметка в `vaults/crm`.
