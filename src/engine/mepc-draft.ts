/* ============================================================
 *  MEPC DRAFT  (Phase 5)
 *  Serialize the filled state of a MepcSchema (values + sources, keyed by
 *  sheet|cell) so it can be saved on the server / localStorage and re-applied
 *  to a freshly-extracted schema later. Only filled fields are stored.
 * ============================================================ */
import type { MepcSchema, MepcField } from "./mepc-schema";

export interface MepcDraft { values: Record<string, { v: string | number; s?: string }>; savedAt: number; }

const key = (f: MepcField) => `${f.sheet}||${f.cell}`;
const isFilled = (f: MepcField) => f.value != null && f.value !== "";

export function serializeDraft(schema: MepcSchema): MepcDraft {
  const values: Record<string, { v: string | number; s?: string }> = {};
  for (const s of schema.sheets) for (const f of s.fields) if (isFilled(f)) values[key(f)] = { v: f.value as any, s: f.source };
  return { values, savedAt: Date.now() };
}

/** Apply a saved draft over a schema (draft wins). Returns fields restored. */
export function applyDraft(schema: MepcSchema, draft: MepcDraft | null | undefined): number {
  if (!draft || !draft.values) return 0;
  let n = 0;
  for (const s of schema.sheets) for (const f of s.fields) {
    const d = draft.values[key(f)];
    if (d && d.v != null && d.v !== "") { f.value = d.v; f.filled = true; f.source = d.s || "Draft"; n++; }
  }
  return n;
}
