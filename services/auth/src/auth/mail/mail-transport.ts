/**
 * ⚠️ **THE PORT MOVED** to `libs/common/src/mail/mail-transport.ts` (feature 033, research R7).
 *
 * Feature 033 added a second sender — conversation replies, owned by chats — and this file argued for
 * itself that the egress check belongs at one boundary *"impossible to bypass by adding a caller"*. So
 * the definition now lives in shared code and this file re-exports it.
 *
 * It is kept rather than deleted because the DI binding in `auth.module.ts` and feature 028's tests
 * import from this path, and those tests are the regression proof that the move changed no behaviour:
 * they must pass **unmodified**. Deleting the file would have meant editing them, which would have
 * removed the only evidence that nothing broke.
 */
export {
  MAIL_TRANSPORT,
  MailSendError,
  type MailAttachment,
  type MailErrorClass,
  type MailMessage,
  type MailTransport,
} from '@crm/common';
