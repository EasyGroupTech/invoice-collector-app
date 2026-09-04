import { PDFParse } from 'pdf-parse';

/** Extracted text of every page, concatenated — the field-extraction regexes in
 * invoice-text-parsing.ts don't need per-page structure. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}
