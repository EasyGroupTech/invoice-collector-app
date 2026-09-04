export const PACKAGE_NAME = 'ic-email-to-downloads';

// Phase 1.14a: the testable, plugin-free building blocks — Graph API calls, built-in
// field-extraction, PDF text extraction. The actual SourcePlugin (discover()/fetchContent(),
// wizard, session wiring — the real `manifest.main` default export) and the local-folder
// destination are 1.14b/1.15, not built yet.
export * from './graph-mail.js';
export * from './invoice-text-parsing.js';
export * from './pdf-text.js';
