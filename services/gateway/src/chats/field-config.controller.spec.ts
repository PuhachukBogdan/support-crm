import { of } from 'rxjs';
import { Reflector } from '@nestjs/core';
import type { ClientGrpc } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import type { Request } from 'express';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';
import { FieldConfigController } from './field-config.controller';

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30) — the fields/forms REST edge.
 *
 * As with the statuses edge: the permission gate is asserted by REFLECTION (a `new`-built
 * controller exercises no decorator; the guard's deny-by-default behaviour has its own spec in
 * `security/permission.guard.spec.ts` — a route declaring the key IS the 403 for a caller without
 * it). What behaves here is the thin-proxy SHAPE translation: wire builders that forward what was
 * sent and default what was not, POST-creates with an empty key, PATCH-edits by the param, and
 * the explicit `clear` marker on the value write.
 */

function controllerFor() {
  const calls: Array<{ rpc: string; data: Record<string, unknown>; md: Metadata }> = [];
  const record =
    (rpc: string) =>
    (data: Record<string, unknown>, md: Metadata) => {
      calls.push({ rpc, data, md });
      return of({ echoed: true, ...data });
    };
  const service = {
    getFieldConfiguration: record('configuration'),
    getConversationFieldView: record('view'),
    upsertFieldDefinition: record('upsertField'),
    upsertOptionSet: record('upsertOptionSet'),
    deleteOptionSet: record('deleteOptionSet'),
    upsertForm: record('upsertForm'),
    setConversationForm: record('setForm'),
    setConversationFieldValue: record('setFieldValue'),
  };
  const client = { getService: () => service } as unknown as ClientGrpc;
  const controller = new FieldConfigController(client);
  controller.onModuleInit();
  return { controller, calls };
}

const req = {
  claims: { accountId: 'acc-1', userId: 'u-admin', roles: ['admin'] },
  effective: { permissionKeys: ['platform.field.manage'] },
} as unknown as Request;

describe('*** every route declares its key — the server-side 403 for anyone below it ***', () => {
  const reflector = new Reflector();
  const required = (h: unknown) => reflector.get<string>(REQUIRED_PERMISSION_KEY, h as never);

  it('all 8 /admin/field-config routes require `platform.field.manage`', () => {
    for (const handler of [
      FieldConfigController.prototype.configuration,
      FieldConfigController.prototype.createField,
      FieldConfigController.prototype.updateField,
      FieldConfigController.prototype.createOptionSet,
      FieldConfigController.prototype.updateOptionSet,
      FieldConfigController.prototype.deleteOptionSet,
      FieldConfigController.prototype.createForm,
      FieldConfigController.prototype.updateForm,
    ]) {
      expect(required(handler)).toBe('platform.field.manage');
    }
  });

  it('the ticket-window routes ride the existing keys — view reads, reply writes', () => {
    expect(required(FieldConfigController.prototype.conversationFieldView)).toBe('crm.inbox.view');
    expect(required(FieldConfigController.prototype.setForm)).toBe('crm.conversation.reply');
    expect(required(FieldConfigController.prototype.setFieldValue)).toBe('crm.conversation.reply');
  });
});

describe('fieldWire — forwards what was sent, defaults what was not (shape only, no dictionary)', () => {
  it('POST creates with an EMPTY key (the service derives it) and safe defaults', async () => {
    const { controller, calls } = controllerFor();
    await controller.createField({ label: 'PSP', type: 'dropdown', optionSetId: 'os-1' }, req);
    expect(calls[0]!.data).toEqual({
      key: '', // ← create: the key is the service's derivation, never the edge's
      label: 'PSP',
      type: 'dropdown',
      required: false,
      restricted: false,
      optionSetId: 'os-1',
      brandIds: [],
      active: true, // absent means "not archiving", not "archive"
    });
    expect(calls[0]!.md.get('x-actor-permissions')).toEqual(['platform.field.manage']);
  });

  it('PATCH edits by the param key; brandIds keeps strings ONLY; flags forward', async () => {
    const { controller, calls } = controllerFor();
    await controller.updateField(
      'psp',
      {
        label: 'PSP (edited)',
        type: 'dropdown',
        required: true,
        restricted: true,
        brandIds: ['b-1', 5, null, 'b-2'] as never,
        active: false,
      },
      req,
    );
    expect(calls[0]!.data).toMatchObject({
      key: 'psp',
      label: 'PSP (edited)',
      required: true,
      restricted: true,
      brandIds: ['b-1', 'b-2'], // non-strings dropped, never coerced
      active: false, // the explicit archive
    });
  });
});

describe('optionSetWire — the whole set travels as a unit', () => {
  it('values default order to their index and active to true; POST sends an empty id', async () => {
    const { controller, calls } = controllerFor();
    await controller.createOptionSet(
      { name: 'Deposit status', values: [{ value: 'Declined' }, { value: 'Pending', order: 7, active: false }] },
      req,
    );
    expect(calls[0]!.data).toEqual({
      id: '',
      name: 'Deposit status',
      values: [
        { value: 'Declined', order: 0, active: true },
        { value: 'Pending', order: 7, active: false },
      ],
      // A present array IS the composition — the edge says so explicitly (criterion ①).
      replaceValues: true,
    });
  });

  it('⭐ PATCH with NO values array is a rename-only edit — replace_values travels FALSE', async () => {
    // The review finding this pins: proto3 cannot tell an absent list from an empty one, so a bare
    // rename/archive PATCH must not read as "every value disappeared". The EDGE states which it was.
    const { controller, calls } = controllerFor();
    await controller.updateOptionSet('os-9', { name: 'Renamed' }, req);
    expect(calls[0]!.data).toEqual({ id: 'os-9', name: 'Renamed', values: [], replaceValues: false });
  });

  it('DELETE forwards the id alone', async () => {
    const { controller, calls } = controllerFor();
    await controller.deleteOptionSet('os-9', req);
    expect(calls[0]!).toMatchObject({ rpc: 'deleteOptionSet', data: { id: 'os-9' } });
  });
});

describe('formWire — entries with their conditions and the sub-category designation', () => {
  it('forwards a full composition and defaults per-entry blanks', async () => {
    const { controller, calls } = controllerFor();
    await controller.createForm(
      {
        name: 'Deposits',
        category: 'Deposits',
        entries: [
          { fieldKey: 'l1', isSubcategorySource: true },
          { fieldKey: 'l2', conditionFieldKey: 'l1', conditionValue: 'Deposit status' },
        ],
      },
      req,
    );
    expect(calls[0]!.data).toEqual({
      key: '',
      name: 'Deposits',
      category: 'Deposits',
      active: true,
      order: 0,
      entries: [
        { fieldKey: 'l1', order: 0, conditionFieldKey: '', conditionValue: '', isSubcategorySource: true },
        { fieldKey: 'l2', order: 1, conditionFieldKey: 'l1', conditionValue: 'Deposit status', isSubcategorySource: false },
      ],
      replaceEntries: true,
    });
  });

  it('⭐ an archive PATCH with NO entries array keeps the composition — replace_entries FALSE', async () => {
    const { controller, calls } = controllerFor();
    await controller.updateForm('deposits', { name: 'Deposits v2', active: false }, req);
    expect(calls[0]!.data).toMatchObject({
      key: 'deposits',
      name: 'Deposits v2',
      active: false,
      entries: [],
      replaceEntries: false,
    });
  });
});

describe('the ticket-window proxies', () => {
  it('the view forwards the conversation id with the caller context', async () => {
    const { controller, calls } = controllerFor();
    await controller.conversationFieldView('c-1', req);
    expect(calls[0]!).toMatchObject({ rpc: 'view', data: { conversationId: 'c-1' } });
  });

  it('the form choice forwards formKey; a non-string travels as the empty (clearing) choice', async () => {
    const { controller, calls } = controllerFor();
    await controller.setForm('c-1', { formKey: 'deposits' }, req);
    expect(calls[0]!.data).toEqual({ conversationId: 'c-1', formKey: 'deposits' });
    await controller.setForm('c-1', {}, req);
    expect(calls[1]!.data).toEqual({ conversationId: 'c-1', formKey: '' });
  });

  it('⭐ the value write forwards `clear: true` — emptiness is an explicit act end to end', async () => {
    const { controller, calls } = controllerFor();
    await controller.setFieldValue('c-1', 'amount', { value: '100' }, req);
    expect(calls[0]!.data).toEqual({ conversationId: 'c-1', fieldKey: 'amount', value: '100', clear: false });

    await controller.setFieldValue('c-1', 'amount', { clear: true }, req);
    expect(calls[1]!.data).toEqual({ conversationId: 'c-1', fieldKey: 'amount', value: '', clear: true });
  });
});
