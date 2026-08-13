import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';
import { AUTH_CLIENT } from '../grpc/clients.module';

/**
 * ⭐ W32 (roadmap 12.10) — the deny-list, held in memory so the boundary can decide without I/O.
 *
 * ── Why a cache and not a call ──────────────────────────────────────────────────────────────────
 * This is consulted on EVERY request, including the ones that need no session. A round trip per
 * request would put a gRPC call in front of the health probe and the login page, and make auth's
 * availability the availability of the whole product. The effective-permission cache one folder over
 * exists for the same reason and this follows its shape.
 *
 * ── ⚠️ The list is DEPLOYMENT-WIDE, and that is forced ──────────────────────────────────────────
 * The requirement is to refuse **before** authentication, and an anonymous request carries no account
 * — so there is nothing to scope by at the moment the decision is made. The rows are stored per
 * account (that is where the screen and the trail belong); this reads their union. Today one
 * operating account exists and the distinction is invisible. With two, one account could deny the
 * other's users. Written here rather than discovered, and named in the feature's research.
 *
 * ── ⚠️ A refresh failure keeps the LAST KNOWN list ──────────────────────────────────────────────
 * Not an empty one. Emptying on failure would mean an auth outage silently lifts every ban — the one
 * moment an attacker would most like it lifted. Starting empty is different and is the honest state:
 * before the first successful load we have never known of any ban.
 */
interface AuthEdgeGrpc {
  listDeniedAddressesForEdge(d: Record<string, never>, md: Metadata): Observable<{ addresses?: string[] }>;
}

/** 🅿 PROVISIONAL. A ban an administrator saves is visible to THIS process at once (see `invalidate`); */
/** this bounds how long another instance can still be serving the caller. Revised with ops. */
const REFRESH_MS = 30_000;

@Injectable()
export class DeniedAddressCache implements OnModuleInit {
  private readonly logger = new Logger(DeniedAddressCache.name);
  private auth!: AuthEdgeGrpc;
  private addresses: readonly string[] = [];
  private loadedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(@Inject(AUTH_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    /**
     * ⚠️ `AuthService`, not the maintenance surface — and the correction is worth recording. This was
     * drafted against `AuthMaintenanceService` and `tests/worker/maintenance-ticks.spec.ts` refused
     * it, correctly: in this product a maintenance rpc means «only a tick may call it», and this one
     * is read by the GATEWAY on a timer. It belongs beside `ValidateToken` — infrastructure the
     * gateway asks auth for, on no session, because at that moment there is no session.
     */
    this.auth = this.client.getService<AuthEdgeGrpc>('AuthService');
    // Warm it, but never block the boot on auth being up: an empty list denies nobody, which is the
    // correct behaviour for «we have not learned of any ban yet».
    void this.refresh();
  }

  /** What the boundary compares against. Never awaits — this is on every request's path. */
  current(): readonly string[] {
    if (Date.now() - this.loadedAt > REFRESH_MS) void this.refresh();
    return this.addresses;
  }

  /**
   * ⭐ The same answer, but WAITING for the first load if it has not happened.
   *
   * ⚠️ Written after the live round found the hole: `current()` returns whatever it has and refreshes
   * in the background, so on a COLD cache — including one whose first load failed at boot — the first
   * callers are checked against an empty list and walk straight through. On the HTTP path that is a
   * handful of requests during startup. On the SOCKET it is worse: a connection is long-lived, so one
   * unchecked upgrade buys a banned caller a live event feed for as long as they care to hold it.
   *
   * The socket can afford to wait — a connection is established once, not per request — so it uses
   * this and the HTTP boundary keeps the synchronous one.
   */
  async currentAwaited(): Promise<readonly string[]> {
    if (this.loadedAt === 0 || Date.now() - this.loadedAt > REFRESH_MS) await this.refresh();
    return this.addresses;
  }

  /** The admin edge calls this after a write, so a ban takes effect here immediately. */
  async invalidate(): Promise<void> {
    this.loadedAt = 0;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    // One in-flight load at a time: a burst of requests past the TTL must not become a burst of calls.
    if (this.inFlight) return this.inFlight;
    const md = new Metadata();
    md.set('x-actor-kind', 'system');
    this.inFlight = (async () => {
      try {
        const res = await firstValueFrom(this.auth.listDeniedAddressesForEdge({}, md));
        this.addresses = (res.addresses ?? []).map((a) => String(a)).filter((a) => a !== '');
        this.loadedAt = Date.now();
      } catch (e) {
        // ⚠️ Keep the previous list and say so ONCE per failure. Emptying here would lift every ban
        // the moment auth wavered. The class only — this path has no identifiers to leak, but the
        // rule is the service's, not the line's.
        this.logger.warn(`denied-address refresh failed: ${(e as Error)?.name ?? 'error'}`);
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
