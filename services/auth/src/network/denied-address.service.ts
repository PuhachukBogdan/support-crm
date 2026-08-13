import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { normalise } from '@crm/common';
import { AuditRepository } from '../audit/audit.repository';
import type { ActorContext } from '../security/actor-context';
import {
  DeniedAddressRepository,
  type DeniedAddressRow,
  type NewDeniedAddress,
} from './denied-address.repository';

/**
 * The deny-list an administrator manages (W32 / feature 039, roadmap 12.10 — research D4/D5).
 *
 * ── The address is stored NORMALISED, and by the boundary's own helper ──────────────────────────
 * `parseIpAllowList` from `@crm/common` is the same normalisation `isAddressDenied` and
 * `clientAddressFrom` apply at the edge (lower-case, IPv4-mapped IPv6 unwrapped). Storing what was
 * typed instead would let one machine be banned in a shape nothing ever matches — a ban that is
 * present on the screen, on the trail, and stops nobody. One normaliser, used on both sides, is what
 * makes the comparison a set-membership test rather than a parsing exercise (FR-029).
 *
 * ── ⚠️ THE AUDIT: the address is the TARGET, and the detail is EMPTY ────────────────────────────
 * Not a style choice and not an omission. `looksLikePersonalData`
 * (`libs/common/src/audit/detail.ts`) strips dots before counting digits, so `203.0.113.7` becomes an
 * 8-digit run and is REFUSED as personal data, while `10.0.0.1` becomes 5 digits and passes. An
 * address written into `detail_json` would therefore make recording a ban succeed or fail **depending
 * on which address was banned** — a defect nobody could reproduce on purpose, discovered months later
 * by an administrator whose ban would not save. That is the same defect class W31 caught on the key
 * fingerprint, where roughly one issuance in 220 would have thrown under a fully green suite
 * (FR-032). `target_ref` carries no such check (`libs/common/src/audit/entry.ts`), and the address IS
 * the target: there is nothing left for a detail to say.
 *
 * The action's CLASS is the catalogue's to decide and changes nothing here — with no detail there is
 * no per-class allow-list to satisfy. (It is registered as `privilege` today; research D5 argued
 * `assignment`. Either reading writes the same row.)
 *
 * ── There is no logging in this file, deliberately ──────────────────────────────────────────────
 * Addresses pass through here. The cheapest structural guarantee is a module that never acquired a
 * logger: no line to redact, no formatter to get right, nothing to accidentally interpolate an
 * address into. The `api-keys/` precedent, applied to the other kind of value worth protecting.
 */

/** A note is a label an administrator types, not prose — the audit detail layer caps values at 120 too. */
const MAX_NOTE_LENGTH = 120;

export type AddOutcome =
  | { status: 'ok'; row: DeniedAddressRow; created: boolean }
  | { status: 'invalid' };

export type RemoveOutcome = { removed: boolean };

@Injectable()
export class DeniedAddressService {
  constructor(
    @Inject(DeniedAddressRepository) private readonly addresses: DeniedAddressRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  list(accountId: string): Promise<DeniedAddressRow[]> {
    return this.addresses.list(accountId);
  }

  /** The deployment-wide union the boundary compares against — see the repository's banner. */
  listForEdge(): Promise<string[]> {
    return this.addresses.listAllForEdge();
  }

  /**
   * Add an address to the account's list.
   *
   * ⚠️ **A repeat is a QUIET SUCCESS, not a conflict** (contract §A1). The unique index absorbs it and
   * the existing row is the answer: an administrator who types the same address twice has expressed
   * the same intent twice, and an error there would teach them to distrust the screen. Caught as
   * P2002 rather than pre-checked, because a pre-check is a race — two administrators saving at once
   * would still reach the index, and only one of them would have been told.
   *
   * ⓘ The P2002 rolls the transaction back, which means the SECOND add writes **no second audit
   * entry**. That is the wanted reading: the list did not change, so the trail has nothing to record.
   */
  async add(actor: ActorContext, rawAddress: string, rawNote: string): Promise<AddOutcome> {
    const address = normaliseAddress(rawAddress);
    if (!isStorableAddress(address)) return { status: 'invalid' };

    const note = (rawNote ?? '').trim();
    // Refused rather than truncated: silently storing half of what somebody typed is worse than
    // telling them, and a note this long is prose that belongs somewhere a person can read it.
    if (note.length > MAX_NOTE_LENGTH) return { status: 'invalid' };

    const row: NewDeniedAddress = {
      // Minted here rather than by the database default: the audit entry has to name the act before
      // the row exists, and on a create there is nothing to read it back from (the api-keys precedent).
      id: randomUUID(),
      address,
      note,
      createdBy: actor.userId,
    };

    // Built BEFORE the transaction opens: `statement()` validates eagerly, so an inexpressible entry
    // refuses the change instead of being rolled back afterwards (feature 015).
    const entry = this.entryFor(actor, address);

    try {
      await this.addresses.insert(actor.accountId, row, entry);
    } catch (err) {
      if ((err as { code?: string })?.code !== 'P2002') throw err;
      const existing = await this.addresses.byAddress(actor.accountId, address);
      // A P2002 means the row exists; if it does not, it was removed between the collision and this
      // read and the caller's request never happened. Re-thrown rather than answered with a row we
      // invented — this surface must not report a ban it did not store.
      if (!existing) throw err;
      return { status: 'ok', row: existing, created: false };
    }

    // Read back, so the answer is what was stored rather than what was intended.
    const stored = await this.addresses.byId(actor.accountId, row.id);
    return { status: 'ok', row: stored ?? asRow(actor.accountId, row), created: true };
  }

  /**
   * Remove one entry. Idempotent: a row that is already gone answers `removed: false` rather than
   * failing — the administrator's intent (this address is not banned) holds either way, and a repeat
   * from a double-click must not read as an error.
   *
   * The entry is read first so the trail can name the ADDRESS rather than the row id: an id says
   * nothing to a reader a year later, and the row it pointed at no longer exists to be looked up.
   */
  async remove(actor: ActorContext, id: string): Promise<RemoveOutcome> {
    const existing = await this.addresses.byId(actor.accountId, (id ?? '').trim());
    // No row ⇒ nothing changed ⇒ nothing to record. An audit entry here would claim an act that never
    // happened, which is the one way to make the trail lie.
    if (!existing) return { removed: false };

    const entry = this.entryFor(actor, existing.address);
    const removed = await this.addresses.remove(actor.accountId, existing.id, entry);
    return { removed: removed > 0 };
  }

  /** The one shape both writes record. See the class banner for why there is no detail. */
  private entryFor(actor: ActorContext, address: string): unknown {
    return this.audit.statement(actor.accountId, {
      action: 'ip_ban.config_changed',
      actorUserId: actor.userId,
      underPreview: actor.underPreview,
      // ⛔ The address goes HERE and nowhere else. Never `detail` — see the class banner (FR-032).
      targetRef: address,
    });
  }
}

/** Normalise exactly as the boundary does — the array form, so a comma is never a separator here. */
export function normaliseAddress(raw: string | undefined | null): string {
  // `normalise` became exported in W32 for exactly this: the writer and the boundary must share
  // one function, or a ban is stored in a shape nothing matches.
  return normalise(raw ?? '');
}

/**
 * Is this a plain address we can store and compare?
 *
 * ⛔ **No ranges, no masks, no wildcards** — the deliberate limit of the address helper this list
 * shares (`libs/common/src/net/ip-allow-list.ts`) and of the feature itself (spec, «out of scope»). A
 * netmask parser has to be right about edge cases before anybody notices it is wrong, and a wrong one
 * either bans nobody or bans everybody. `10.0.0.0/24` is refused at the door instead of being stored
 * as a string that matches no client on earth.
 *
 * ⚠️ Leading zeros are refused for the same reason, and this one is easy to miss: `010.0.0.1` is a
 * plausible thing to type, `Number('010')` is 10, and a naive octet check accepts it — after which the
 * banned string is `010.0.0.1` while every real client presents `10.0.0.1`. The screen would show a
 * ban that matches nothing. Exact-match comparison makes the WRITTEN FORM part of the meaning, so the
 * validation has to be about the form and not only about the numbers.
 */
export function isStorableAddress(normalised: string): boolean {
  if (normalised === '') return false;
  return isIpv4(normalised) || isIpv6(normalised);
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith('0')) return false; // see the leading-zero note above
    return Number(part) <= 255;
  });
}

/**
 * IPv6 in the shape a client actually presents. `::ffff:203.0.113.7` never reaches here — the shared
 * normaliser unwraps it to its IPv4 form first, which is the whole point of normalising before
 * validating. A zone suffix (`fe80::1%eth0`) is refused: it names an interface on one machine, not an
 * address anybody can be identified by across the boundary.
 */
function isIpv6(value: string): boolean {
  if (!value.includes(':')) return false;
  if (!/^[0-9a-f:]+$/.test(value)) return false; // already lower-cased by the normaliser
  if (value.includes(':::')) return false;
  const abbreviations = value.split('::').length - 1;
  if (abbreviations > 1) return false; // `::` may appear once — otherwise the value is ambiguous
  const groups = value.split(':').filter((g) => g !== '');
  if (groups.some((g) => g.length > 4)) return false;
  if (abbreviations === 1) return groups.length <= 7;
  return groups.length === 8 && !value.startsWith(':') && !value.endsWith(':');
}

/** Fallback shape when the read-back is unavailable — the same fields, filled from what was written. */
function asRow(accountId: string, entry: NewDeniedAddress): DeniedAddressRow {
  return {
    id: entry.id,
    account_id: accountId,
    address: entry.address,
    note: entry.note === '' ? null : entry.note,
    created_by: entry.createdBy,
    created_at: new Date(),
  };
}
