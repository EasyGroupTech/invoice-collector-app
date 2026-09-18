import { PDFParse } from 'pdf-parse';
import type { PdfApi } from 'invoice-collector-plugin-sdk';

/**
 * The real `PdfApi` implementation (SDK's own `context.ts` doc comment explains why this lives
 * in core, not in every plugin that needs it) — `pdf-parse` is `ic-core`'s own dependency now,
 * built once per real target platform exactly like the rest of the packaged app, rather than a
 * plugin bundling its own copy of a native-binding dependency into a standalone artifact that's
 * only ever built once, for one platform (§11 item 2 — the real bug this closes).
 */
export function createPdfApi(): PdfApi {
  return {
    async extractText(bytes: Uint8Array): Promise<string> {
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await parser.getText();
        return result.text;
      } finally {
        await parser.destroy();
      }
    },
  };
}
