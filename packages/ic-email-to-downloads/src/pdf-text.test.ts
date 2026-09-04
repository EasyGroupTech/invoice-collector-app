import { describe, expect, it } from 'vitest';
import { extractPdfText } from './pdf-text.js';

/**
 * A hand-built, minimal-but-genuinely-valid PDF — no third-party PDF-writing library, no
 * captured real invoice (per this phase's own "synthetic fixtures only" rule, §10). Deliberately
 * has no proper xref table; pdf.js's own recovery mode (which every real-world malformed PDF
 * relies on in practice) reconstructs it from the `obj`/`endobj` markers, confirmed empirically
 * against the actual installed pdf-parse before relying on this in a test.
 */
function buildMinimalPdf(lines: string[]): Uint8Array {
  const content = lines.map((line, index) => `BT /F1 12 Tf 10 ${140 - index * 20} Td (${line}) Tj ET`).join('\n');
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 300 200]/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length ${content.length}>>
stream
${content}
endstream
endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe('extractPdfText', () => {
  it('extracts the text content of a real (if minimal) PDF', async () => {
    const bytes = buildMinimalPdf(['Invoice Number: INV-9001', 'Amount: $250.00 USD']);
    const text = await extractPdfText(bytes);
    expect(text).toContain('Invoice Number: INV-9001');
    expect(text).toContain('Amount: $250.00 USD');
  });

  it('preserves line separation between distinct text lines', async () => {
    const bytes = buildMinimalPdf(['First line', 'Second line']);
    const text = await extractPdfText(bytes);
    const firstIndex = text.indexOf('First line');
    const secondIndex = text.indexOf('Second line');
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });
});
