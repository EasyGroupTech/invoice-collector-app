import type { DetailDescriptor, FieldDescriptor, ListDescriptor } from 'invoice-collector-plugin-sdk';
import { describe, expect, it } from 'vitest';
import { fieldsOf, isFieldVisible, seedDetailValuesFromRow, validateWizardValues } from './wizard-form-state.js';

const folderField: FieldDescriptor = { kind: 'field', name: 'folder', label: 'Folder', type: 'text', required: true };
const useCustomField: FieldDescriptor = { kind: 'field', name: 'useCustomFolder', label: 'Use a custom folder?', type: 'checkbox' };
const customFolderField: FieldDescriptor = {
  kind: 'field',
  name: 'customFolder',
  label: 'Custom folder path',
  type: 'text',
  required: true,
  visibleWhen: { field: 'useCustomFolder', equals: true },
};

const messagesList: ListDescriptor = {
  kind: 'list',
  name: 'messages',
  label: 'Messages',
  columns: [{ key: 'subject', label: 'Subject' }],
  dataSource: 'mailPreview',
};

const messageDetail: DetailDescriptor = {
  kind: 'detail',
  name: 'messageDetail',
  label: 'Selected message',
  showsSelectionFrom: 'messages',
  fields: [
    { kind: 'field', name: 'subject', label: 'Subject', type: 'text', required: true },
    { kind: 'field', name: 'invoiceNumber', label: 'Invoice #', type: 'text' },
  ],
};

describe('fieldsOf', () => {
  it('returns the field itself for a FieldDescriptor step', () => {
    expect(fieldsOf(folderField)).toEqual([folderField]);
  });

  it('returns its nested fields for a DetailDescriptor step', () => {
    expect(fieldsOf(messageDetail)).toEqual(messageDetail.fields);
  });

  it('returns no fields for a ListDescriptor step', () => {
    expect(fieldsOf(messagesList)).toEqual([]);
  });
});

describe('isFieldVisible', () => {
  it('is always visible when visibleWhen is absent', () => {
    expect(isFieldVisible(folderField, {})).toBe(true);
  });

  it('is visible when the named field currently equals the expected value', () => {
    expect(isFieldVisible(customFolderField, { useCustomFolder: true })).toBe(true);
  });

  it('is hidden when the named field does not currently equal the expected value', () => {
    expect(isFieldVisible(customFolderField, { useCustomFolder: false })).toBe(false);
    expect(isFieldVisible(customFolderField, {})).toBe(false);
  });
});

describe('validateWizardValues', () => {
  it('is valid when every required, visible field has a value', () => {
    const result = validateWizardValues([folderField], { folder: 'Inbox' });
    expect(result).toEqual({ valid: true, missingFields: [] });
  });

  it('reports a missing required field', () => {
    const result = validateWizardValues([folderField], {});
    expect(result).toEqual({ valid: false, missingFields: ['folder'] });
  });

  it('treats an empty string the same as missing', () => {
    const result = validateWizardValues([folderField], { folder: '' });
    expect(result.valid).toBe(false);
  });

  it('never requires a field hidden by its own visibleWhen condition', () => {
    const result = validateWizardValues([useCustomField, customFolderField], { useCustomFolder: false });
    expect(result).toEqual({ valid: true, missingFields: [] });
  });

  it('requires a visibleWhen-gated field once its condition is met', () => {
    const result = validateWizardValues([useCustomField, customFolderField], { useCustomFolder: true });
    expect(result).toEqual({ valid: false, missingFields: ['customFolder'] });
  });

  it('validates required fields nested inside a DetailDescriptor step', () => {
    const result = validateWizardValues([messagesList, messageDetail], { subject: '' });
    expect(result).toEqual({ valid: false, missingFields: ['subject'] });
  });

  it('ignores non-required fields entirely', () => {
    const result = validateWizardValues([messageDetail], { subject: 'Invoice from Acme' });
    expect(result).toEqual({ valid: true, missingFields: [] });
  });
});

describe('seedDetailValuesFromRow', () => {
  it('seeds each detail field from the matching key on the selected row', () => {
    const row = { subject: 'Invoice from Acme', invoiceNumber: 'INV-1', unrelated: 'x' };
    expect(seedDetailValuesFromRow(messageDetail, row)).toEqual({
      subject: 'Invoice from Acme',
      invoiceNumber: 'INV-1',
    });
  });

  it('seeds every field to undefined when nothing is selected yet', () => {
    expect(seedDetailValuesFromRow(messageDetail, undefined)).toEqual({
      subject: undefined,
      invoiceNumber: undefined,
    });
  });

  it('seeds undefined for a field the selected row does not have', () => {
    expect(seedDetailValuesFromRow(messageDetail, { subject: 'Invoice from Acme' })).toEqual({
      subject: 'Invoice from Acme',
      invoiceNumber: undefined,
    });
  });
});
