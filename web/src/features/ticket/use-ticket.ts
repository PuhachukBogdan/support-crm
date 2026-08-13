'use client';

import { useCallback, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '@/store';
import { ticketActions } from '@/store/ticket/ticket.slice';
import type { TicketState } from '@/store/ticket/ticket.slice';

/**
 * Binds the route's conversation id to the ticket store (W7).
 *
 * `open` fires on mount and on id change (switching tickets through the URL is a full replace);
 * `close` on unmount, so a stray late response has no state to land in. Everything else the window
 * does is a dispatch returned from here — components never import the store directly.
 */
export function useTicket(id: string): Omit<TicketState, 'send'> & {
  /** The composer's in-flight state — renamed from the slice's `send`, which the ACTION shadows. */
  sendState: TicketState['send'];
  refresh: () => void;
  send: (input: { kind: 'reply' | 'note'; body: string; uploadIds?: string[]; statusTo?: string }) => void;
  takeIt: (operatorId: string) => void;
  attachLabel: (labelId: string) => void;
  detachLabel: (labelId: string) => void;
  applyMacro: (macroId: string) => void;
  /** 2026-08-10 — the left column's field writes. `priority: ''` clears it. */
  setSubject: (subject: string) => void;
  setStatus: (status: string) => void;
  setPriority: (priority: string) => void;
  setBrand: (brandId: string) => void;
} {
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((s: RootState) => s.ticket);

  useEffect(() => {
    dispatch(ticketActions.open({ id }));
    return () => {
      dispatch(ticketActions.close());
    };
  }, [dispatch, id]);

  const refresh = useCallback(() => dispatch(ticketActions.refresh({ id })), [dispatch, id]);
  const send = useCallback(
    (input: { kind: 'reply' | 'note'; body: string; uploadIds?: string[]; statusTo?: string }) =>
      dispatch(ticketActions.send({ id, ...input })),
    [dispatch, id],
  );

  const takeIt = useCallback(
    (operatorId: string) => dispatch(ticketActions.takeIt({ id, operatorId })),
    [dispatch, id],
  );
  const attachLabel = useCallback(
    (labelId: string) => dispatch(ticketActions.attachLabel({ id, labelId })),
    [dispatch, id],
  );
  const detachLabel = useCallback(
    (labelId: string) => dispatch(ticketActions.detachLabel({ id, labelId })),
    [dispatch, id],
  );
  const applyMacro = useCallback(
    (macroId: string) => dispatch(ticketActions.applyMacro({ id, macroId })),
    [dispatch, id],
  );

  const setSubject = useCallback(
    (subject: string) => dispatch(ticketActions.setSubject({ id, subject })),
    [dispatch, id],
  );
  const setStatus = useCallback(
    (status: string) => dispatch(ticketActions.setStatus({ id, status })),
    [dispatch, id],
  );
  const setPriority = useCallback(
    (priority: string) => dispatch(ticketActions.setPriority({ id, priority })),
    [dispatch, id],
  );
  const setBrand = useCallback(
    (brandId: string) => dispatch(ticketActions.setBrand({ id, brandId })),
    [dispatch, id],
  );

  const { send: sendState, ...rest } = state;
  return {
    ...rest,
    sendState,
    refresh,
    send,
    takeIt,
    attachLabel,
    detachLabel,
    applyMacro,
    setSubject,
    setStatus,
    setPriority,
    setBrand,
  };
}
