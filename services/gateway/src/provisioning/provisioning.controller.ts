import {
  Controller,
  Delete,
  Inject,
  OnModuleInit,
  Param,
  Post,
  RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { clientAddressFrom } from '@crm/common';
import { AUTH_CLIENT } from '../grpc/clients.module';
import { Public } from '../auth/public.decorator';

/**
 * ⭐ W31 / feature 038 (roadmap 3.15, ADR 0043 §6): the staff-provisioning namespace.
 *
 * ── What makes this different from every other controller here ──────────────────────────────────
 * It is `@Public()`: no session, no cookie, no `x-actor-*`. The caller is another team's system
 * holding a key, and the authentication travels in the signature. That is the whole reason the route
 * lives in its own namespace with its own version in the path — a machine boundary and a human one
 * must never be one surface, because the day they are, a session bug becomes a provisioning bug.
 *
 * ⚠️ **This edge decides NOTHING and orchestrates NOTHING.** It forwards the raw bytes, the headers
 * and the caller's address to auth, and renders whatever comes back. No key is stored here, no
 * signature is verified here, no refusal is invented here (Principle VIII — and the channel intake's
 * own precedent one folder up).
 *
 * ⚠️ **In particular it does not move the departed person's work**, though an earlier draft did. The
 * handover is a maintenance rpc, and `tests/worker/maintenance-ticks.spec.ts` refuses to let the
 * gateway name one: «only a tick may call it — if HTTP can ask, the system-actor check is
 * decoration». The guard was right twice over, because the draft was also passing an auth user id
 * where chats expects a `users.Operator.id`. The offboarding sweep in the worker owns it now.
 *
 * ⚠️ **problem+json lives ONLY here.** The web client reads status codes and deliberately ignores
 * bodies, so a product-wide envelope change would be a large blast radius for no benefit; a machine
 * consumer, by contrast, gets a typed body it can branch on (research D9).
 */

interface ProvisioningResultWire {
  statusCode?: number;
  problemType?: string;
  outcome?: string;
  bodyJson?: string;
}

interface AuthProvisioningGrpc {
  provisionStaff(d: Record<string, unknown>): Observable<ProvisioningResultWire>;
  deactivateStaff(d: Record<string, unknown>): Observable<ProvisioningResultWire>;
}

/** One header value, never a joined list — a repeated header is a caller error, not a concatenation. */
function headerOf(req: RawBodyRequest<Request>, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? undefined : raw;
}

/**
 * ⚠️ **`provisioning/v1`, NOT `api/provisioning/v1`** — the external URL the HR platform calls IS
 * `/api/provisioning/v1/staff`, but `/api` is stripped before the gateway sees it: `web/next.config`
 * rewrites `/api/:path*` to the gateway with the prefix removed (feature 019 — the browser never
 * learns the gateway's origin). Carrying the prefix here again produced a 404 on the live round with
 * every unit test green, because nothing in the suite crosses that rewrite. The problem+json
 * `instance` fields keep the FULL external path — that is what the caller sees and quotes back.
 */
@Controller('provisioning/v1')
export class ProvisioningController implements OnModuleInit {
  private auth!: AuthProvisioningGrpc;

  constructor(@Inject(AUTH_CLIENT) private readonly authClient: ClientGrpc) {}

  onModuleInit(): void {
    this.auth = this.authClient.getService<AuthProvisioningGrpc>('AuthService');
  }

  /** `<id>.<secret>` — split on the FIRST dot; the secret half may contain anything. */
  private splitKey(header: string | undefined): { id: string; secret: string } {
    const raw = (header ?? '').trim();
    const dot = raw.indexOf('.');
    if (dot <= 0 || dot === raw.length - 1) return { id: '', secret: '' };
    return { id: raw.slice(0, dot), secret: raw.slice(dot + 1) };
  }

  private common(req: RawBodyRequest<Request>) {
    const { id, secret } = this.splitKey(headerOf(req, 'x-crm-key'));
    return {
      keyId: id,
      keySecret: secret,
      signatureHeader: headerOf(req, 'x-crm-signature') ?? '',
      idempotencyKey: headerOf(req, 'idempotency-key') ?? '',
      // ⚠️ The address comes from the LAST forwarded entry — the one our own edge appended. A client
      // that sets `x-forwarded-for` itself cannot spoof its way onto an allow-list (@crm/common).
      clientIp: clientAddressFrom(headerOf(req, 'x-forwarded-for'), req.socket?.remoteAddress),
      receivedAt: Math.floor(Date.now() / 1000),
      // ⚠️ `req.rawBody`, never `req.body`: the signature covers exactly the bytes that arrived, and a
      // parsed-then-reserialised body is a different byte string — every signature would fail and the
      // symptom would read as «the provider signs wrongly». `main.ts` enables `rawBody` for this
      // reason and `channels/raw-body.spec.ts` pins it; this is the same property, a second consumer.
      rawBody: req.rawBody?.toString('utf8') ?? '',
    };
  }

  /** Render the service's decision verbatim: status, content type, body. */
  private render(res: Response, out: ProvisioningResultWire): unknown {
    const status = out.statusCode && out.statusCode > 0 ? out.statusCode : 500;
    res.status(status);
    res.type(out.problemType ? 'application/problem+json' : 'application/json');
    try {
      return JSON.parse(out.bodyJson ?? '{}');
    } catch {
      return {};
    }
  }

  @Public()
  @Post('staff')
  async createStaff(@Req() req: RawBodyRequest<Request>, @Res({ passthrough: true }) res: Response) {
    return this.render(res, await firstValueFrom(this.auth.provisionStaff(this.common(req))));
  }

  @Public()
  @Delete('staff/:hrEmployeeId')
  async offboardStaff(
    @Param('hrEmployeeId') hrEmployeeId: string,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await firstValueFrom(
      this.auth.deactivateStaff({ ...this.common(req), hrEmployeeId }),
    );
    return this.render(res, out);
  }
}
