import type { ObjectStore } from './object-store';

/**
 * A deterministic in-memory object store (feature 016, T023).
 *
 * Track A must stay Docker-independent, so every spec that exercises the upload path substitutes
 * this for the S3 client. `import type` above is erased at compile time, so importing the fake does
 * NOT pull `@aws-sdk/client-s3` into a test process.
 *
 * It records operations in order. That matters for one test in particular: FR-009 says a rejected
 * upload leaves nothing behind, and the honest way to check that is not "the row is absent" but
 * "no `put` ever happened" — an assertion about what the code did, not about what survived.
 *
 * `failNextPut` / `failNextDelete` exist for the fault injection in `create-failure.spec.ts`
 * (SC-011). They are one-shot rather than a persistent mode so a test cannot accidentally leave the
 * store broken for the assertions that follow it.
 */
export interface StoreOp {
  op: 'put' | 'get' | 'delete' | 'exists';
  key: string;
}

export class InMemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  readonly ops: StoreOp[] = [];

  /** When set, the next `put` throws with this error and the flag clears. */
  failNextPut: Error | null = null;
  /** When set, the next `delete` throws with this error and the flag clears. */
  failNextDelete: Error | null = null;

  put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.ops.push({ op: 'put', key });
    if (this.failNextPut) {
      const err = this.failNextPut;
      this.failNextPut = null;
      return Promise.reject(err);
    }
    // Copy: the caller's buffer is reused by the validation path, and a fake that aliased it would
    // make a mutation-after-store bug invisible here and live in production.
    this.objects.set(key, { body: Uint8Array.from(body), contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array | null> {
    this.ops.push({ op: 'get', key });
    const found = this.objects.get(key);
    return Promise.resolve(found ? Uint8Array.from(found.body) : null);
  }

  delete(key: string): Promise<void> {
    this.ops.push({ op: 'delete', key });
    if (this.failNextDelete) {
      const err = this.failNextDelete;
      this.failNextDelete = null;
      return Promise.reject(err);
    }
    this.objects.delete(key);
    return Promise.resolve();
  }

  /**
   * Presence, recorded like every other operation (feature 017).
   *
   * `failNextExists` is separate from `failNextDelete` on purpose: the purge treats an unanswerable
   * store as "leave the row alone", and a fake that could not distinguish the two failures would let
   * that path pass by accident.
   */
  failNextExists: Error | null = null;

  exists(key: string): Promise<boolean> {
    this.ops.push({ op: 'exists', key });
    if (this.failNextExists) {
      const err = this.failNextExists;
      this.failNextExists = null;
      return Promise.reject(err);
    }
    return Promise.resolve(this.objects.has(key));
  }

  /** Keys currently held — the "what survived" view, for tests that need it after the op log. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  puts(): string[] {
    return this.ops.filter((o) => o.op === 'put').map((o) => o.key);
  }

  deletes(): string[] {
    return this.ops.filter((o) => o.op === 'delete').map((o) => o.key);
  }

  reset(): void {
    this.objects.clear();
    this.ops.length = 0;
    this.failNextPut = null;
    this.failNextDelete = null;
    this.failNextExists = null;
  }
}
