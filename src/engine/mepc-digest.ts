/* ============================================================
 *  MEPC DIGEST  (Phase 4)
 *  Maps values out of uploaded supporting files into the schema's still-
 *  empty fields. Two layers, in order:
 *    1. a generic "label → value" REGEX pass (fast, deterministic), and
 *    2. an OpenAI pass over the remaining gaps (handles fuzzy wording).
 *  Every value written records its source (regex/AI + the file it came
 *  from). Text extraction (pdf/xlsx/txt) is done by the caller and passed
 *  in as {name,text}, so this module stays pure & unit-testable.
 * ============================================================ */
import type { MepcSchema, MepcField } from "./mepc-schema";
import { openaiChat } from "./sources";

export interface DigestSource { name: string; text: string; }
export interface DigestMapping { sheet: string; cell: string; label: string; value: string | number; source: string; }
export interface DigestResult { mapped: number; mappings: DigestMapping[]; usedAI: boolean; }

const norm = (s: any) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const isEmpty = (f: MepcField) => f.value == null || f.value === "";

/** Coerce a raw extracted string to a field's value (dropdown→option, %→fraction). */
function coerce(f: MepcField, raw: string): string | number | null {
  const s = String(raw).trim();
  if (s === "") return null;
  if (f.type === "dropdown" || f.type === "checkbox") {
    const n = norm(s);
    let hit = (f.options || []).find((o) => norm(o) === n);
    if (!hit) hit = (f.options || []).find((o) => norm(o).includes(n) || n.includes(norm(o)));
    return hit || null;
  }
  if (f.type === "percent") { const n = parseFloat(s.replace(/[%,\s]/g, "")); if (!isFinite(n)) return null; return /%/.test(s) || n > 1.5 ? n / 100 : n; }
  if (f.type === "number") { const n = parseFloat(s.replace(/[,\s$]/g, "")); return isFinite(n) ? n : null; }
  return s.replace(/\s+/g, " ").trim().slice(0, 250);
}

/** Which file a match index falls under (by the "=== FILE: name ===" markers). */
function fileAt(corpus: string, idx: number): string {
  const before = corpus.slice(0, idx);
  const m = [...before.matchAll(/=== FILE: ([^=]+?) ===/g)].pop();
  return m ? m[1].trim() : "file";
}

/** Generic label→value extraction for one field from the corpus. */
function regexExtract(corpus: string, f: MepcField): { value: string; file: string } | null {
  const label = (f.label || "").trim();
  if (label.length < 3) return null;
  // use the first informative chunk of the label (some labels are paragraphs)
  const lab = label.split(/[.(]/)[0].trim().slice(0, 48);
  const escLab = lab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // "Label : value"  or  "Label   value"  up to end of line / next label
  const re = new RegExp(escLab + "\\s*[:=]?\\s*([^\\n\\r|\\t]{1,80})", "i");
  const m = corpus.match(re);
  if (!m) return null;
  let cand = m[1].trim();
  if (f.type === "dropdown" || f.type === "checkbox") {
    // the value must be (or contain) one of the allowed options
    const opt = (f.options || []).find((o) => norm(cand).includes(norm(o)) || norm(o).includes(norm(cand.split(/\s{2,}/)[0])));
    if (!opt) return null; cand = opt;
  } else if (f.type === "number" || f.type === "percent") {
    const num = (cand.match(/-?[\d.,]+\s*%?/) || [])[0]; if (!num) return null; cand = num;
  }
  if (!cand) return null;
  return { value: cand, file: fileAt(corpus, m.index!) };
}

/** Collect the empty, meaningfully-labelled fields worth trying to fill. */
function collectEmptyFields(schema: MepcSchema, cap = 160): MepcField[] {
  const out: MepcField[] = [];
  for (const s of schema.sheets) for (const f of s.fields) if (isEmpty(f) && (f.label || "").trim().length >= 3) out.push(f);
  // prefer General Information first, then the rest, capped to keep prompts sane
  out.sort((a, b) => (a.sheet === "General Information" ? 0 : 1) - (b.sheet === "General Information" ? 0 : 1));
  return out.slice(0, cap);
}

/** Ask OpenAI to map corpus → {sheet,cell,value} for the remaining empty fields. */
async function aiMap(corpus: string, fields: MepcField[], openaiKey: string, model: string): Promise<{ sheet: string; cell: string; value: string }[]> {
  const fieldList = fields.map((f) => ({ sheet: f.sheet, cell: f.cell, label: f.label.slice(0, 80), type: f.type, options: f.options?.slice(0, 16) }));
  const data = await openaiChat({
    model: model || "gpt-4o-mini",
    messages: [
      { role: "system", content: "You extract values for a LEED energy-calculator form from supporting documents. For each FIELD you are confident about, return its value found in the TEXT. Only include fields you actually find. For dropdown fields the value MUST be one of the given options (verbatim). Reply as JSON {\"mappings\":[{\"sheet\":\"…\",\"cell\":\"…\",\"value\":\"…\"}]}." },
      { role: "user", content: `FIELDS:\n${JSON.stringify(fieldList)}\n\nTEXT:\n${corpus.slice(0, 14000)}` },
    ],
    temperature: 0, response_format: { type: "json_object" },
  }, openaiKey);
  try { const j = JSON.parse(data.choices[0].message.content); return Array.isArray(j.mappings) ? j.mappings : []; }
  catch { return []; }
}

export interface DigestOpts { openaiKey?: string; openaiModel?: string; useAI?: boolean; }

/** Map the uploaded files into the schema's empty fields (regex, then AI). */
export async function digestFiles(sources: DigestSource[], schema: MepcSchema, opts: DigestOpts = {}): Promise<DigestResult> {
  const corpus = sources.map((s) => `=== FILE: ${s.name} ===\n${s.text}`).join("\n\n");
  const mappings: DigestMapping[] = [];
  const apply = (f: MepcField, value: string | number, source: string) => { f.value = value; f.filled = true; f.source = source; mappings.push({ sheet: f.sheet, cell: f.cell, label: f.label, value, source }); };

  const empties = collectEmptyFields(schema);
  // 1) regex pass
  for (const f of empties) {
    const hit = regexExtract(corpus, f); if (!hit) continue;
    const v = coerce(f, hit.value); if (v == null) continue;
    apply(f, v, `Regex · ${hit.file}`);
  }
  // 2) AI pass over what's still empty
  let usedAI = false;
  const remaining = empties.filter(isEmpty);
  if (opts.useAI !== false && opts.openaiKey && remaining.length) {
    usedAI = true;
    const byKey = new Map(remaining.map((f) => [f.sheet + "|" + f.cell, f]));
    const ai = await aiMap(corpus, remaining, opts.openaiKey, opts.openaiModel || "gpt-4o-mini");
    for (const m of ai) {
      const f = byKey.get((m.sheet || "") + "|" + (m.cell || "")); if (!f || !isEmpty(f)) continue;
      const v = coerce(f, String(m.value)); if (v == null) continue;
      apply(f, v, `AI · supporting files`);
    }
  }
  return { mapped: mappings.length, mappings, usedAI };
}
