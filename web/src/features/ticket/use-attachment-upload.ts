'use client';

import { useCallback, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';

/** A file the composer holds, already accepted by the server and waiting to ride a message. */
export interface PendingAttachment {
  uploadId: string;
  name: string;
}

/**
 * Composer attachments (W7-6). Each file goes to `POST /uploads/message_attachment` — the one
 * byte-accepting route in the product — as it is picked, so by send time the message only carries
 * `uploadIds`. The server judges size (10 MB) and type (png/jpeg/webp/gif/pdf, BY CONTENT); a
 * refusal surfaces here as the file NOT joining the list plus an error line — the client
 * deliberately re-checks nothing, because a second, looser judge is how the two drift apart.
 *
 * Files upload SEQUENTIALLY, not in parallel: attachment lists are 1–3 files, and one failure
 * naming one file beats three interleaved failures naming none.
 *
 * ⓘ Removing a chip only drops the local reference. The upload stays server-side, unclaimed —
 * claiming happens when a message names it (describe → claim → insert), and an upload nothing ever
 * claims is the server's own housekeeping, not this hook's.
 */
export function useAttachmentUpload() {
  const dataAccess = useDataAccess();
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(
    async (files: ArrayLike<File>) => {
      setUploading(true);
      setError(null);
      try {
        for (const file of Array.from(files)) {
          const form = new FormData();
          form.append('file', file, file.name);
          // The route answers the proto's `Upload` message — the field is `id` (users.proto:287).
          // The first live run failed EXACTLY here: this read `uploadId`, a field the wire never
          // had, and every upload "succeeded" into an empty string.
          const res = await dataAccess.create<{ id?: string }>('message-attachment-uploads', form);
          const uploadId = typeof res?.id === 'string' ? res.id : '';
          if (uploadId === '') {
            // A 2xx with no id is a contract break, not a user problem — say so and stop.
            throw new Error('upload accepted but no id returned');
          }
          setAttachments((prev) => [...prev, { uploadId, name: file.name }]);
        }
      } catch (e) {
        setError(toDataError(e).message);
      } finally {
        setUploading(false);
      }
    },
    [dataAccess],
  );

  const remove = useCallback((uploadId: string) => {
    setAttachments((prev) => prev.filter((a) => a.uploadId !== uploadId));
  }, []);

  const clear = useCallback(() => {
    setAttachments([]);
    setError(null);
  }, []);

  return { attachments, uploading, error, add, remove, clear };
}
