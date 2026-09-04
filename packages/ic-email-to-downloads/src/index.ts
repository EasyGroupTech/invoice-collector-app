export const PACKAGE_NAME = 'ic-email-to-downloads';

export * from './graph-mail.js';
export * from './invoice-text-parsing.js';
export * from './pdf-text.js';
export * from './mail-filter.js';
export * from './file-naming.js';

// The compiled form of this file is manifest.main's actual entry point — its default export
// is what core dynamically imports and registers (§9.4). The local-folder destination is 1.15,
// not built yet.
export { default } from './plugin.js';
