'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import { uploadThumbUrl } from '@/data/asset-url';
import type { DataError } from '@/data/types';

interface OperatorWire {
  operatorId?: string;
  displayName?: string;
  avatarUploadId?: string;
}
interface PresenceWire {
  state?: string;
}
interface UploadWire {
  id?: string;
}

/**
 * W19 — the Profile section becomes real (subpoints 5.4 + 5.5).
 *
 * ── The avatar (5.4 → roadmap 8.10) ──────────────────────────────────────────────────────────────
 * One flow, two writes: the FILE goes through feature 016's single ingest path
 * (`POST /uploads/avatar` — 2 MB, png/jpeg/webp verified by MAGIC BYTES, never by the claimed
 * type; SVG deliberately outside the list), then the returned id is PLACED on my profile
 * (`PUT /me/operator/avatar`). What renders is the 256px derivative the ingest always makes —
 * `/uploads/{id}/thumb` — so a 2 MB photo costs a list row nothing. The display NAME is read-only
 * by decision (2026-07-26): it is how colleagues and the audit trail know you.
 *
 * ── Presence (5.5 → the 025 engine) ──────────────────────────────────────────────────────────────
 * «On shift» = `online`, «Break» = `away` — the closed state set the server owns; the write is a
 * PUT on MY singleton and the router (031) reads the same store, which is what makes «на перерыве —
 * тикеты не приходят» one fact rather than two. The full label catalogue (why on break) is 025's
 * remainder, not offered here.
 */
export function ProfileSection() {
  const dataAccess = useDataAccess();
  const [operator, setOperator] = useState<OperatorWire | null>(null);
  const [presence, setPresence] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DataError | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void dataAccess
      .get<OperatorWire>('me-operator', '')
      .then((res) => alive && setOperator(res))
      .catch(() => alive && setOperator({}));
    void dataAccess
      .get<PresenceWire>('my-presence', '')
      .then((res) => alive && setPresence(res?.state ?? ''))
      .catch(() => alive && setPresence(''));
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  const uploadAvatar = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      // ⚠️ The multipart field name is `file` — the 016 route's contract (W7's attachments use it).
      const form = new FormData();
      form.append('file', file);
      const uploaded = await dataAccess.create<UploadWire>('avatar-uploads', form);
      // The wire has `Upload.id` — W7's live run caught a hook inventing `uploadId` here.
      const id = uploaded?.id ?? '';
      if (!id) throw { message: 'The upload did not answer with an id.', retryable: true };
      const fresh = await dataAccess.update<OperatorWire>('my-avatar', '', { uploadId: id });
      setOperator(fresh);
    } catch (e) {
      setError(toDataError(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const setState = async (state: 'online' | 'away') => {
    setBusy(true);
    setError(null);
    try {
      await dataAccess.update('my-presence', '', { state });
      setPresence(state);
    } catch (e) {
      setError(toDataError(e));
    } finally {
      setBusy(false);
    }
  };

  const avatarId = operator?.avatarUploadId ?? '';
  const onBreak = presence === 'away';

  return (
    <section className="space-y-3 rounded-md border border-border p-3" data-testid="settings-profile">
      <h2 className="text-sm font-semibold">Profile</h2>

      <div className="flex items-center gap-3">
        {avatarId ? (
          // The 256px derivative the ingest always makes — never the original on a profile row.
          <img
            src={uploadThumbUrl(avatarId)}
            alt="Your avatar"
            className="h-12 w-12 rounded-full object-cover"
            data-testid="avatar-image"
          />
        ) : (
          <span
            className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground"
            data-testid="avatar-placeholder"
          >
            no photo
          </span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          data-testid="avatar-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadAvatar(f);
          }}
        />
        <Button size="sm" variant="outline" disabled={busy} data-testid="avatar-pick" onClick={() => fileRef.current?.click()}>
          {avatarId ? 'Change photo' : 'Add photo'}
        </Button>
        <span className="text-xs text-muted-foreground">
          PNG, JPEG or WebP up to 2 MB — checked by content, not by file name.
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm">Status</span>
        <Button
          size="sm"
          variant={!onBreak ? 'secondary' : 'outline'}
          disabled={busy}
          data-testid="presence-online"
          onClick={() => void setState('online')}
        >
          On shift
        </Button>
        <Button
          size="sm"
          variant={onBreak ? 'secondary' : 'outline'}
          disabled={busy}
          data-testid="presence-away"
          onClick={() => void setState('away')}
        >
          Break
        </Button>
        {onBreak && (
          <span className="text-xs text-muted-foreground" data-testid="presence-note">
            New tickets are not routed to you while on break.
          </span>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive" data-testid="profile-error">
          {error.message}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Your name{operator?.displayName ? ` (${operator.displayName})` : ''} is not editable by
        decision: it is how colleagues and the audit trail know you.
      </p>
    </section>
  );
}
