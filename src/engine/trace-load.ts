/* ============================================================
 *  Browser-only PDF loader for TRACE reports (pdf.js + worker).
 *  Kept separate from trace.ts so the parser stays Node-testable.
 * ============================================================ */
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { TracePage, altOf } from "./trace";

(pdfjsLib as any).GlobalWorkerOptions.workerSrc = workerUrl;

/** Read every page to normalized text. onProgress(done,total) for UI feedback. */
export async function loadTracePages(
  buf: ArrayBuffer, onProgress?: (d: number, t: number) => void
): Promise<TracePage[]> {
  const doc = await (pdfjsLib as any).getDocument({ data: new Uint8Array(buf) }).promise;
  const total = doc.numPages;
  const pages: TracePage[] = [];
  for (let p = 1; p <= total; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const text = tc.items.map((i: any) => i.str).join(" ").replace(/\s+/g, " ").trim();
    pages.push({ n: p, text, alt: altOf(text) });
    page.cleanup();
    if (onProgress && (p % 25 === 0 || p === total)) onProgress(p, total);
  }
  try { await doc.destroy(); } catch { /* ignore */ }
  return pages;
}
