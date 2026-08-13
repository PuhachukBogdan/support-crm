'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState, DataError } from '@/data/types';
import type { BrandWire } from '@/features/contacts/types';
import type { FieldBody, FieldConfigWire, FormBody, OptionSetBody } from './types';

/**
 * ⭐ W30 (спек №1, roadmap 4.15) — the authoring screen's reads and writes.
 *
 * ONE read projection (`admin-field-config`, a singleton): sets, fields and forms arrive together,
 * so the three tabs can never disagree about what exists. Every write ends in a RE-READ of that
 * projection (the W28 rule — nothing is merged locally): the screen renders what the server now
 * holds, including a write it refused.
 *
 * Brands degrade ALONE: they only name the applicability picker; a failed brands read leaves the
 * picker absent rather than the screen broken (the macros groups precedent).
 */
export function useTicketFields() {
  const dataAccess = useDataAccess();
  const [config, setConfig] = useState<AsyncState<FieldConfigWire>>({ status: 'idle' });
  const [brands, setBrands] = useState<BrandWire[]>([]);
  const [mutation, setMutation] = useState<DataError | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setConfig((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    void dataAccess
      .get<FieldConfigWire>('admin-field-config', '')
      .then((c) => {
        if (!alive) return;
        const empty = c.fields.length === 0 && c.optionSets.length === 0 && c.forms.length === 0;
        setConfig(empty ? { status: 'empty' } : { status: 'ready', data: c });
      })
      .catch((e) => alive && setConfig({ status: 'error', error: toDataError(e) }));

    void dataAccess
      .list<BrandWire>('brands', { limit: 100 })
      .then((page) => alive && setBrands(page.items))
      // Degrades ALONE — see the header.
      .catch(() => alive && setBrands([]));

    return () => {
      alive = false;
    };
  }, [dataAccess, nonce]);

  /** One write shape for every entity; the re-read is the standing effect above (via nonce). */
  const write = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setMutation(null);
      setBusyKey(key);
      try {
        await fn();
        refresh();
        return true;
      } catch (e) {
        setMutation(toDataError(e));
        return false;
      } finally {
        setBusyKey(null);
      }
    },
    [refresh],
  );

  const createField = useCallback(
    (body: FieldBody) => write('field-new', () => dataAccess.create('admin-field', body)),
    [dataAccess, write],
  );
  const updateField = useCallback(
    (key: string, body: FieldBody) =>
      write(`field-${key}`, () => dataAccess.update('admin-field', key, body)),
    [dataAccess, write],
  );

  const createSet = useCallback(
    (body: OptionSetBody) => write('set-new', () => dataAccess.create('admin-option-set', body)),
    [dataAccess, write],
  );
  const updateSet = useCallback(
    (id: string, body: OptionSetBody) =>
      write(`set-${id}`, () => dataAccess.update('admin-option-set', id, body)),
    [dataAccess, write],
  );
  // The one hard delete in the family — the screen offers it, the SERVER decides (409 in words
  // while any field references the set), and the refusal lands in `mutation`.
  const removeSet = useCallback(
    (id: string) => write(`set-${id}`, () => dataAccess.remove('admin-option-set', id)),
    [dataAccess, write],
  );

  const createForm = useCallback(
    (body: FormBody) => write('form-new', () => dataAccess.create('admin-form', body)),
    [dataAccess, write],
  );
  const updateForm = useCallback(
    (key: string, body: FormBody) =>
      write(`form-${key}`, () => dataAccess.update('admin-form', key, body)),
    [dataAccess, write],
  );

  return {
    config,
    brands,
    mutation,
    busyKey,
    refresh,
    createField,
    updateField,
    createSet,
    updateSet,
    removeSet,
    createForm,
    updateForm,
  };
}
