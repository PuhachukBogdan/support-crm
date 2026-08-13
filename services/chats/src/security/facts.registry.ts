import type { PrismaService } from '../prisma.service';

/**
 * ⭐ W32 / feature 039 (roadmap 12.11, research D3) — **chats' contribution to the security page.**
 *
 * The twin of `services/auth/src/security/facts.registry.ts`, and deliberately a twin rather than a
 * shared module: each service owns the facts it can SEE, states them in its own words, and answers
 * them behind the same permission the screen uses. The gateway concatenates. A shared registry would
 * need one service to read another's database, which Principle VIII forbids for better reasons than
 * this page has for wanting it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ The honesty rule, restated because this file is read on its own:
 *   • `kind: 'read'`     ⇒ MUST carry a `read` that queries. Its answer is what the database says in
 *                          THIS request, or the row must not exist.
 *   • `kind: 'built_in'` ⇒ carries NO `read`, and its value is a NAMED CONSTANT below. The page
 *                          renders it as «встроено», never as a control that happens to be on.
 * `tests/security-posture/facts-are-read.spec.ts` reads this file as text and fails the build when
 * the two blur. A page of hand-typed rows is indistinguishable by eye from a page of live ones, and
 * that scan is the only thing that stays true.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⛔ **Not here, on purpose** (research D3, the chats half): **маскирование контактов.** It is the
 * read path's behaviour, not a setting — there is no switch, so a row for it would be a claim about
 * source code dressed as a control. What guards it is `tests/exports/contact-data-gate.spec.ts` and
 * the field gate below, not a sentence on a page.
 */

export type FactSeverity = 'critical' | 'recommended' | 'informational';
export type FactKind = 'read' | 'built_in';
export type FactState = 'ok' | 'attention' | 'unknown';

export interface FactReading {
  state: FactState;
  /** Already rendered — the page formats nothing it does not understand. */
  value: string;
  note?: string;
}

/** What a reader is given: the ACCOUNT-SCOPED client, and nothing else. chats has no posture config. */
export interface ChatsFactContext {
  db: ReturnType<PrismaService['forAccount']>;
}

/**
 * One row of the registry. The two shapes are mutually exclusive and the guard enforces it:
 *   `{ kind: 'read', read }` — and no `value` field on the entry;
 *   `{ kind: 'built_in', value }` — and no `read` field at all.
 */
export interface SecurityFactEntry {
  key: string;
  label: string;
  severity: FactSeverity;
  kind: FactKind;
  /** `null` = this deployment does not have the condition at all. NEVER used for a failed read. */
  read?: (ctx: ChatsFactContext) => Promise<FactReading | null>;
  /** Present ⟺ `kind === 'built_in'`. Always a named constant. */
  value?: string;
  note?: string;
}

/**
 * ⭐ The ONE built-in claim chats makes.
 *
 * A field marked `restricted` is withheld DEFINITION AND VALUE from a caller without
 * `crm.conversation.restricted_field.view` — the resolution happens in `fields.grpc.controller.ts`
 * and in the ticket write path, and it is not a setting: nobody can turn the withholding off while
 * leaving the mark on. It earns a row because the READ row beside it («ограниченных полей: N») says
 * nothing about what «ограничено» does, and a number without its meaning is where a false assurance
 * starts.
 */
const RESTRICTED_FIELD_MEANING = 'скрывается вместе со значением, а не только помечается';

export const CHATS_SECURITY_FACTS: readonly SecurityFactEntry[] = [
  {
    /**
     * ⚠️ A disabled channel refuses deliveries exactly like an unknown one — so a customer writing
     * to it gets silence, and nothing anywhere reports an error. That is why «выключено» is worth
     * attention rather than being a neutral count.
     */
    key: 'chats.channels.enabled',
    label: 'Каналы приёма обращений',
    severity: 'recommended',
    kind: 'read',
    read: async (ctx) => {
      const [total, enabled] = await Promise.all([
        ctx.db.channel.count(),
        ctx.db.channel.count({ where: { enabled: true } }),
      ]);
      const off = total - enabled;
      return {
        state: off > 0 ? 'attention' : 'ok',
        value: 'включено ' + String(enabled) + ' из ' + String(total),
        note: 'Выключенный канал отказывает так же, как неизвестный: письмо в него просто не доходит.',
      };
    },
  },
  {
    /**
     * ⓘ Zero is the SEEDED state, not a defect (Q15: по умолчанию ничего не ограничено). So this row
     * is informational and stays `ok` at any number — it tells an administrator what the mechanism is
     * currently doing, and «ноль» is a legitimate answer to that.
     */
    key: 'chats.fields.restricted',
    label: 'Ограниченные поля тикета',
    severity: 'informational',
    kind: 'read',
    read: async (ctx) => {
      const restricted = await ctx.db.fieldDefinition.count({
        where: { active: true, restricted: true },
      });
      return {
        state: 'ok',
        value: String(restricted),
        note: 'Их не видят роли без права «видеть ограниченные поля тикета».',
      };
    },
  },
  {
    /**
     * ⚠️ **`built_in`, so it carries no `read`.** See {@link RESTRICTED_FIELD_MEANING}: this is what
     * the read path does, not something an administrator switched on — and the count above it inverts
     * in meaning without it («помечено N полей» reads as a label, not as a withholding).
     */
    key: 'chats.fields.restricted_withholds_value',
    label: 'Ограниченное поле',
    severity: 'informational',
    kind: 'built_in',
    value: RESTRICTED_FIELD_MEANING,
    note: 'Свойство продукта, а не настройка: отдельного переключателя для этого нет.',
  },
];
