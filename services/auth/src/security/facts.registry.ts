import { normalizeFixedLoginCode, parseFixedLoginCodeEmails, type AuthConfig } from '../config';
import type { PrismaService } from '../prisma.service';

/**
 * ⭐ W32 / feature 039 (roadmap 12.11, research D3) — **auth's contribution to the security page,
 * declared as a registry of READERS.**
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS FILE IS SHAPED THE WAY IT IS, AND NOT AS A LIST OF ROWS
 *
 * The security page is the one screen in the product where being wrong is worse than being absent:
 * a row saying «ключи ограничены по адресам» converts an unknown risk into a false assurance
 * somebody acts on. And the cheap version of this page — a list of statements that were true the
 * day somebody typed them — is **indistinguishable by eye** from the real thing.
 *
 * So honesty is made STRUCTURAL rather than promised:
 *   • `kind: 'read'`  ⇒ the entry MUST carry a `read` that queries, and its answer is whatever the
 *                       database or the running configuration says in THIS request;
 *   • `kind: 'built_in'` ⇒ the entry carries NO `read` at all, and its value comes from a NAMED
 *                       CONSTANT below, so the page can label it «встроено», never «включено».
 *
 * `tests/security-posture/facts-are-read.spec.ts` reads this file as text and fails the build when
 * the two blur — a `read` whose body awaits nothing is a constant wearing a reader's clothes, and a
 * `built_in` that grew a reader is a setting pretending to be a property.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⛔ **What is deliberately NOT here, each for a stated reason** (research D3). Every one of these is
 * tempting precisely because it would make the page look more thorough:
 *
 *  1. **`User.mfa_enabled`.** The column exists and NOTHING in the product reads it — not the login
 *     path, not a guard, not a policy. Rendering it would state that a protection is configured when
 *     no code anywhere consults the configuration. That is not an incomplete fact, it is a false one.
 *  2. **Session lifetimes (`ACCESS_TTL` / `SESSION_TTL` / `REMEMBER_TTL`).** They are declared in
 *     BOTH `services/auth/src/config.ts` and `services/gateway/src/config.ts`. auth would show its
 *     own copy while the gateway's copy is what actually expires a session, so the page would be
 *     accurate about a number that decides nothing. One value in two places is a fact this page
 *     cannot state honestly until it is a fact in one place.
 *  3. **The content-security policy.** A literal constant in gateway code
 *     (`services/gateway/src/security/csp.ts`). Reading a constant back out and printing it is
 *     ceremony: it proves the constant exists, which was never in doubt, and it would rot into
 *     «configured» in a reader's memory.
 *  4. **«Код на почту при входе».** Not a switch. The two-step login is STRUCTURAL — there is no
 *     branch that turns it off (`login.service.ts`) — so presenting it as a control implies a
 *     control panel that does not exist, and implies it could be off.
 *  5. **Маскирование контактов.** Code, not configuration: the masking happens in the read path and
 *     there is no toggle to report. A row for it would be a claim about source code, which is what a
 *     test is for and a page is not.
 *
 * ⓘ The fixed sign-in code is the opposite case and IS here: it is a real, live weakening, read from
 * the running configuration, with a COUNT of affected accounts and ⛔ not one address named.
 */

/** How much attention a departure from the expected value deserves. Ours to define (contract). */
export type FactSeverity = 'critical' | 'recommended' | 'informational';

/**
 * `read` — the value came from a query in THIS request.
 * `built_in` — a property of the product rather than a setting; the page renders it as such.
 */
export type FactKind = 'read' | 'built_in';

/**
 * ⚠️ `unknown` is what a fact becomes when it cannot be established — a failed query, an unreachable
 * service. It is NEVER `ok`: a protection that could not be checked reading as a passing control is
 * the precise failure this page exists to avoid.
 */
export type FactState = 'ok' | 'attention' | 'unknown';

/** What one reader answers. `null` = this weakening is not present in this deployment (see below). */
export interface FactReading {
  state: FactState;
  /** Already rendered — the page formats nothing it does not understand. */
  value: string;
  note?: string;
}

/** What a reader is given: an ACCOUNT-SCOPED client and the configuration the service is running. */
export interface AuthFactContext {
  /** `PrismaService.forAccount(...)` — every read below is confined to the caller's account. */
  db: ReturnType<PrismaService['forAccount']>;
  /** The live config object, not a copy taken at import time. */
  config: Pick<AuthConfig, 'DEV_FIXED_LOGIN_CODE' | 'DEV_FIXED_LOGIN_CODE_EMAILS'>;
}

/**
 * One row of the registry.
 *
 * ⚠️ The two shapes are mutually exclusive and the guard enforces it:
 *   `{ kind: 'read', read }` — no `value` field anywhere on the entry;
 *   `{ kind: 'built_in', value }` — no `read` field at all, and `value` is a named constant.
 */
export interface SecurityFactEntry {
  key: string;
  label: string;
  severity: FactSeverity;
  kind: FactKind;
  /**
   * ⚠️ Returning `null` means «this deployment does not have this weakening at all» and the fact is
   * omitted. It is for a fact whose whole EXISTENCE is conditional (the fixed sign-in code) — never
   * for a read that failed. A failed read is `unknown`, produced by the service, and still shown.
   */
  read?: (ctx: AuthFactContext) => Promise<FactReading | null>;
  /** Present ⟺ `kind === 'built_in'`. Always a named constant, never a literal typed inline. */
  value?: string;
  note?: string;
}

/**
 * ⭐ The ONE built-in claim auth makes, and why it is allowed to be one.
 *
 * An API key whose address list is empty is refused by `isAddressAllowed`
 * (`libs/common/src/net/ip-allow-list.ts`) — an empty allow-list denies everybody. That is not a
 * setting anyone can change from a screen; it is what the function does, and it is asserted by name
 * in `libs/common/src/net/ip-allow-list.spec.ts` («AN EMPTY LIST DENIES»). It earns a row because the
 * READ fact next to it («ключей без адресов: N») is meaningless without it: without this sentence an
 * administrator reads N as «N keys with unrestricted access», the exact inversion.
 */
const EMPTY_ALLOW_LIST_MEANING = 'пустой список адресов запрещает всё';

/** The four account statuses the product writes (010). Unknown values fall through as themselves. */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  active: 'работают',
  disabled: 'отключены',
  pending: 'ожидают',
  invited: 'приглашены',
};

/** `12 работают · 3 приглашены` — counts an administrator reads, in the order the map declares. */
function renderStatusCounts(rows: ReadonlyArray<{ status: string; count: number }>): string {
  if (rows.length === 0) return 'ни одного';
  const order = Object.keys(STATUS_LABELS);
  return [...rows]
    .sort((a, b) => {
      const ia = order.indexOf(a.status);
      const ib = order.indexOf(b.status);
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    })
    .map((r) => String(r.count) + ' ' + (STATUS_LABELS[r.status] ?? r.status))
    .join(' · ');
}

export const AUTH_SECURITY_FACTS: readonly SecurityFactEntry[] = [
  {
    /**
     * ⭐ FR-022 — the one fact on this page that describes a deliberate weakening of sign-in.
     *
     * ⛔ **No address is named, and that is not a redaction step somebody has to remember: the
     * addresses never leave this function.** They go INTO a `count`, and a number comes back. There
     * is no code path here that could put one on the page, which is the difference between «we
     * remembered to strip it» and «it cannot be there».
     *
     * ⚠️ The count is READ, not taken from the length of the configured list: an address configured
     * for nobody weakens nobody, and the honest number is how many accounts of THIS account it
     * actually reaches. Matching is case-insensitive because `OtpService.codeFor` lower-cases both
     * sides — a count that matched more strictly would under-report the real exposure.
     *
     * ⓘ Absent when the feature is off (`read` returns `null`). A permanently-green critical row is
     * noise on a page whose value is that every row on it is worth reading.
     */
    key: 'auth.login.fixed_code',
    label: 'Фиксированный код входа',
    severity: 'critical',
    kind: 'read',
    read: async (ctx) => {
      const code = normalizeFixedLoginCode(ctx.config.DEV_FIXED_LOGIN_CODE ?? '');
      const emails = parseFixedLoginCodeEmails(ctx.config.DEV_FIXED_LOGIN_CODE_EMAILS);
      if (code === '' || emails.length === 0) return null;
      const affected = await ctx.db.user.count({
        where: { email: { in: emails, mode: 'insensitive' } },
      });
      return {
        state: 'attention',
        value: 'включён для ' + String(affected) + ' аккаунтов',
        note:
          'Этим аккаунтам на вход приходит один и тот же код — второй фактор ослаблен. ' +
          'Адреса не показываются намеренно. Выключается удалением двух переменных окружения.',
      };
    },
  },
  {
    /** D3: total · active · revoked in one row — one topic, one line an administrator scans. */
    key: 'auth.api_keys.inventory',
    label: 'Ключи интеграций',
    severity: 'recommended',
    kind: 'read',
    read: async (ctx) => {
      const [total, active] = await Promise.all([
        ctx.db.apiKey.count(),
        ctx.db.apiKey.count({ where: { active: true } }),
      ]);
      return {
        state: 'ok',
        value:
          'всего ' +
          String(total) +
          ' · действующих ' +
          String(active) +
          ' · отозванных ' +
          String(total - active),
        note: 'Ключ выпускается и отзывается на экране ключей; значение ключа не хранится и не показывается.',
      };
    },
  },
  {
    /**
     * ⚠️ Real posture, not bookkeeping. Under the fail-closed allow-list an ACTIVE key with no
     * addresses is a key nobody can use — so this number is «сколько интеграций молча не работают»,
     * which presents to their owner as an outage with no error anywhere.
     */
    key: 'auth.api_keys.without_addresses',
    label: 'Ключи без списка адресов',
    severity: 'recommended',
    kind: 'read',
    read: async (ctx) => {
      const open = await ctx.db.apiKey.count({
        where: { active: true, ip_allow_list: { isEmpty: true } },
      });
      return {
        state: open > 0 ? 'attention' : 'ok',
        value: String(open),
        note:
          'Список адресов работает на запрет: ' +
          EMPTY_ALLOW_LIST_MEANING +
          ', поэтому такой ключ не пройдёт ни один запрос.',
      };
    },
  },
  {
    key: 'auth.accounts.by_status',
    label: 'Учётные записи по состоянию',
    severity: 'informational',
    kind: 'read',
    read: async (ctx) => {
      const rows = await ctx.db.user.groupBy({ by: ['status'], _count: { _all: true } });
      const counts = rows.map((r: { status: string; _count: { _all: number } }) => ({
        status: r.status,
        count: r._count._all,
      }));
      return { state: 'ok', value: renderStatusCounts(counts) };
    },
  },
  {
    /** Right now, not «ever»: `locked_until` in the future. A lockout that expired is not posture. */
    key: 'auth.accounts.locked_now',
    label: 'Заблокированы после неудачных попыток',
    severity: 'informational',
    kind: 'read',
    read: async (ctx) => {
      const locked = await ctx.db.user.count({ where: { locked_until: { gt: new Date() } } });
      return {
        state: locked > 0 ? 'attention' : 'ok',
        value: String(locked),
        note: 'Блокировка снимается сама по времени; несколько сразу — повод посмотреть, кто и откуда подбирал пароль.',
      };
    },
  },
  {
    key: 'auth.roles.permissions',
    label: 'Роли и права в них',
    severity: 'informational',
    kind: 'read',
    read: async (ctx) => {
      const roles = await ctx.db.role.findMany({
        select: { key: true, _count: { select: { rolePermissions: true } } },
      });
      const rendered = [...roles]
        .sort(
          (
            a: { _count: { rolePermissions: number } },
            b: { _count: { rolePermissions: number } },
          ) => b._count.rolePermissions - a._count.rolePermissions,
        )
        .map(
          (r: { key: string; _count: { rolePermissions: number } }) =>
            r.key + ' ' + String(r._count.rolePermissions),
        )
        .join(' · ');
      return {
        state: 'ok',
        value: String(roles.length) + ' ролей: ' + (rendered === '' ? 'ни одной' : rendered),
      };
    },
  },
  {
    /**
     * ⚠️ The reason this row exists: a personal set is INVISIBLE in the role matrix. Somebody read
     * the matrix, saw «агент», and the person has held something else since the day an administrator
     * personalised them.
     */
    key: 'auth.permissions.personal_sets',
    label: 'Люди с личным набором прав',
    severity: 'recommended',
    kind: 'read',
    read: async (ctx) => {
      const personal = await ctx.db.userPermissionSet.count({ where: { mode: 'standalone' } });
      return {
        state: personal > 0 ? 'attention' : 'ok',
        value: String(personal),
        note: 'Их права не меняются вместе с ролью — матрица ролей про них ничего не говорит.',
      };
    },
  },
  {
    /**
     * ⭐ This feature's OWN new posture fact (ADR 0043 §4). A desk with nobody answering for it has
     * no destination when somebody leaves, so the offboarding sweep sends that work to the queue —
     * a rota instead of a relationship. Legitimate as a state, worth seeing as a number.
     */
    key: 'auth.desks.without_lead',
    label: 'Столы без руководителя',
    severity: 'recommended',
    kind: 'read',
    read: async (ctx) => {
      const orphaned = await ctx.db.group.count({ where: { active: true, lead_user_id: null } });
      return {
        state: orphaned > 0 ? 'attention' : 'ok',
        value: String(orphaned),
        note: 'При увольнении клиентов такого стола некому передать — они уходят в общую очередь.',
      };
    },
  },
  {
    key: 'auth.desks.routable',
    label: 'Столы, куда раздаются обращения',
    severity: 'informational',
    kind: 'read',
    read: async (ctx) => {
      const [routable, total] = await Promise.all([
        ctx.db.group.count({ where: { active: true, routable: true } }),
        ctx.db.group.count({ where: { active: true } }),
      ]);
      return {
        state: 'ok',
        value: String(routable) + ' из ' + String(total),
        note: 'Остальные столы наполняются только вручную — автораздача в них не пишет.',
      };
    },
  },
  {
    /**
     * ⚠️ **`built_in`, so it carries no `read` and the page must not render it as a switch.** See
     * {@link EMPTY_ALLOW_LIST_MEANING} for why this one sentence is allowed to be a typed constant:
     * it is what a function does, it is asserted by a test, and the READ row above it inverts in
     * meaning without it.
     */
    key: 'auth.api_keys.empty_list_denies_all',
    label: 'Пустой список адресов у ключа',
    severity: 'informational',
    kind: 'built_in',
    value: EMPTY_ALLOW_LIST_MEANING,
    note: 'Свойство продукта, а не настройка: переключателя для этого нет.',
  },
];
