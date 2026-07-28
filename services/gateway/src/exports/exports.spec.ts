import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import {
  REQUIRED_PERMISSION_KEY,
  REQUIRES_SCOPE_PARAM_KEY,
  RESOLVE_PERMISSIONS_KEY,
} from '../security/requires-permission.decorator';
import { ExportsController } from './exports.controller';
import { parseExportFilters, parsePageSize } from './wire';

/**
 * T023 / T054 (feature 017, US1) — the edge refuses before it does anything, and EVERY route forwards
 * the caller's permissions.
 */
describe('*** every exports route carries permission metadata *** (016 wire defect, found live)', () => {
  /**
   * The route list is DERIVED from the controller, not hardcoded.
   *
   * Feature 016's equivalent test enumerates `['create','read','thumb']` by hand — so a new route added
   * without a decorator AND without being added to the list would pass silently: the same gap in a new
   * place. Deriving it is what makes "a route cannot be added without permission metadata" true rather
   * than aspirational.
   */
  const ROUTE_METHODS = Object.getOwnPropertyNames(ExportsController.prototype as object).filter(
    (name) => name !== 'constructor' && name !== 'onModuleInit' && !name.startsWith('meta'),
  );

  it('the scan sees the real routes (guards against a vacuous pass)', () => {
    expect(ROUTE_METHODS.sort()).toEqual(['create', 'download', 'get', 'list']);
  });

  it.each(ROUTE_METHODS)('%s resolves or enforces permissions', (method) => {
    const handler = (ExportsController.prototype as unknown as Record<string, unknown>)[method] as object;
    const enforces =
      Reflect.getMetadata(REQUIRES_SCOPE_PARAM_KEY, handler) ??
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler);
    const resolves = Reflect.getMetadata(RESOLVE_PERMISSIONS_KEY, handler);
    // Either is acceptable; NEITHER is the defect. Without one of them the guard never populates
    // `req.effective`, the gateway forwards an EMPTY `x-actor-permissions`, and the owning service
    // correctly refuses everything — a 403 on the caller's own export.
    expect({ method, wired: !!(enforces || resolves) }).toEqual({ method, wired: true });
  });

  it('POST enforces the SCOPE-derived key, not a static one', () => {
    // A static string cannot express a parameter-dependent key: it would be wrong for every scope but
    // one. That was the CRITICAL feature 016's /analyze found.
    const handler = (ExportsController.prototype as unknown as Record<string, unknown>).create as object;
    expect(Reflect.getMetadata(REQUIRES_SCOPE_PARAM_KEY, handler)).toBe('scope');
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler)).toBeUndefined();
  });

  it('the GETs resolve WITHOUT enforcing a static key — the decision belongs downstream', () => {
    for (const method of ['list', 'get', 'download']) {
      const handler = (ExportsController.prototype as unknown as Record<string, unknown>)[method] as object;
      expect(Reflect.getMetadata(RESOLVE_PERMISSIONS_KEY, handler)).toBe(true);
      expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler)).toBeUndefined();
    }
  });
});

describe('filters are parsed fail-closed (FR-005/FR-027)', () => {
  it('accepts exactly the conversation list vocabulary', () => {
    expect(
      parseExportFilters({
        status: 'open',
        priority: 'high',
        assigneeOperatorId: 'op-1',
        playerId: 'p-1',
        brandId: 'b-1',
        slaOutcome: 'breached',
      }),
    ).toEqual({
      status: 'open',
      priority: 'high',
      assigneeOperatorId: 'op-1',
      playerId: 'p-1',
      brandId: 'b-1',
      slaOutcome: 'breached',
    });
  });

  it('*** an unknown filter is REFUSED, never dropped ***', () => {
    // Dropping is the dangerous direction: a dropped filter WIDENS the result set, so asking for one
    // brand would silently produce every brand — in a file the caller then forwards.
    expect(() => parseExportFilters({ status: 'open', brnad: 'typo' })).toThrow(BadRequestException);
    expect(() => parseExportFilters({ accountId: 'other-account' })).toThrow(BadRequestException);
  });

  it('the refusal names the KEY and never echoes the value (SEC-26)', () => {
    try {
      parseExportFilters({ secretish: 'alice@example.com' });
      throw new Error('should have refused');
    } catch (err) {
      const message = (err as BadRequestException).message;
      expect(message).toContain('secretish');
      expect(message).not.toContain('alice@example.com');
    }
  });

  it('an unknown enum member is refused rather than widened', () => {
    expect(() => parseExportFilters({ status: 'nonsense' })).toThrow(BadRequestException);
    expect(() => parseExportFilters({ slaOutcome: 'maybe' })).toThrow(BadRequestException);
  });

  it('a non-object body and a non-string value are both refused', () => {
    expect(() => parseExportFilters([])).toThrow(BadRequestException);
    expect(() => parseExportFilters({ playerId: 42 })).toThrow(BadRequestException);
  });

  it('an absent body is an unfiltered export, which is a legitimate request', () => {
    expect(parseExportFilters(undefined)).toEqual({});
    expect(parseExportFilters({})).toEqual({});
  });

  it('empty-string filters are treated as absent, not as a filter on ""', () => {
    expect(parseExportFilters({ playerId: '' })).toEqual({});
  });
});

describe('pageSize is validated, not silently defaulted', () => {
  it('absent means "let the service decide"', () => {
    expect(parsePageSize(undefined)).toBe(0);
    expect(parsePageSize('')).toBe(0);
  });

  it('a positive integer passes through (the service still caps it)', () => {
    expect(parsePageSize('25')).toBe(25);
  });

  it('nonsense is a 400 — `?pageSize=all` quietly becoming 50 teaches the wrong thing', () => {
    for (const bad of ['all', '0', '-5', '1.5', 'NaN']) {
      expect(() => parsePageSize(bad)).toThrow(BadRequestException);
    }
  });
});
