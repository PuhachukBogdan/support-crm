'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState, DataError } from '@/data/types';

/**
 * ⭐ W30 (roadmap 4.15) — the ticket's custom fields, as ONE self-owned read + two writes.
 *
 * The block owns its data the way the panels (W26) and TagsBlock do — a hook over `useDataAccess`,
 * not the ticket saga: the view is per-CALLER (restricted fields are absent by server decision),
 * per-conversation, and nothing above the column consumes it, so parking it in the shared slice
 * would make every keystroke's re-read re-render the thread for no reader's benefit.
 *
 * Every write ends in a re-read of the view (the registry convention — no local merges): the server
 * is where the cascade clears dependents and where the sub-category routes, so only the server's
 * answer shows what a change actually did.
 */

export interface FieldOptionWire {
  value: string;
  order: number;
  active: boolean;
}
export interface FieldDefWire {
  key: string;
  label: string;
  type: string;
  required: boolean;
  restricted: boolean;
}
export interface FieldEntryWire {
  field: FieldDefWire;
  order: number;
  conditionFieldKey: string;
  conditionValue: string;
  isSubcategorySource: boolean;
  options: FieldOptionWire[];
}
export interface ConversationFieldViewWire {
  formKey: string;
  entries: FieldEntryWire[];
  values: { fieldKey: string; value: string }[];
  category: string;
  subCategory: string;
  classifiedBy: string;
  availableForms: { key: string; name: string }[];
}

const EMPTY_VIEW: ConversationFieldViewWire = {
  formKey: '',
  entries: [],
  values: [],
  category: '',
  subCategory: '',
  classifiedBy: '',
  availableForms: [],
};

/** Absent members arrive absent from the wire — normalise once so render code never guards. */
function normalise(raw: unknown): ConversationFieldViewWire {
  const v = (raw ?? {}) as Partial<ConversationFieldViewWire>;
  return {
    ...EMPTY_VIEW,
    ...v,
    entries: (v.entries ?? []).map((e) => ({
      field: {
        key: e.field?.key ?? '',
        label: e.field?.label ?? '',
        type: e.field?.type ?? '',
        required: e.field?.required === true,
        restricted: e.field?.restricted === true,
      },
      order: e.order ?? 0,
      conditionFieldKey: e.conditionFieldKey ?? '',
      conditionValue: e.conditionValue ?? '',
      isSubcategorySource: e.isSubcategorySource === true,
      options: e.options ?? [],
    })),
    values: v.values ?? [],
    availableForms: v.availableForms ?? [],
  };
}

export function useConversationFields(conversationId: string) {
  const da = useDataAccess();
  const [view, setView] = useState<AsyncState<ConversationFieldViewWire>>({ status: 'idle' });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<DataError | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    setView((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    da.get<ConversationFieldViewWire>('conversation-field-view', '', conversationId)
      .then((raw) => {
        if (alive) setView({ status: 'ready', data: normalise(raw) });
      })
      .catch((e) => {
        if (alive) setView({ status: 'error', error: toDataError(e) });
      });
    return () => {
      alive = false;
    };
  }, [da, conversationId, nonce]);

  /** One write at a time per key; success clears the error and re-reads, failure states why. */
  const write = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusyKey(key);
      setMutationError(null);
      try {
        await fn();
        refresh();
      } catch (e) {
        setMutationError(toDataError(e));
      } finally {
        setBusyKey(null);
      }
    },
    [refresh],
  );

  const setForm = useCallback(
    (formKey: string) =>
      write('form', () => da.update('conversation-form', '', { formKey }, conversationId)),
    [da, conversationId, write],
  );
  const setValue = useCallback(
    (fieldKey: string, value: string) =>
      write(fieldKey, () => da.update('conversation-field', fieldKey, { value }, conversationId)),
    [da, conversationId, write],
  );
  const clearValue = useCallback(
    (fieldKey: string) =>
      write(fieldKey, () =>
        da.update('conversation-field', fieldKey, { clear: true }, conversationId),
      ),
    [da, conversationId, write],
  );

  /**
   * A field's CURRENT value: the sub-category source reads the reserved column's echo (its value is
   * never a stored row — D2's single store), everything else reads the values list.
   */
  const valueOf = useMemo(() => {
    if (view.status !== 'ready') return () => '';
    const byKey = new Map(view.data.values.map((v) => [v.fieldKey, v.value]));
    const entries = new Map(view.data.entries.map((e) => [e.field.key, e]));
    return (fieldKey: string): string => {
      const entry = entries.get(fieldKey);
      if (entry?.isSubcategorySource) return view.data.subCategory;
      return byKey.get(fieldKey) ?? '';
    };
  }, [view]);

  return { view, busyKey, mutationError, refresh, setForm, setValue, clearValue, valueOf };
}
