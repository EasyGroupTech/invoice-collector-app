export const PACKAGE_NAME = 'ic-email-to-downloads';

export * from './graph-mail.js';
export * from './invoice-text-parsing.js';
export * from './mail-filter.js';
export * from './file-naming.js';
export * from './package-manifest.js';

// The compiled form of this file is the Graph Mail implementation's own manifest.main entry point
// — its default export is what core dynamically imports and registers (§9.4). The Local Folder
// destination (local-folder-plugin.ts) is its own separate entry point, per PACKAGE_MANIFEST's
// own `implementations[1].main`.
export { default } from './plugin.js';
