/* ============================================================
 *  MEPC MOCKUP POPUP  (Phase 3 — Excel-faithful grid)
 *  Renders each input sheet as a real spreadsheet grid that mirrors the
 *  calculator: every label cell shows its text, merged cells span, column
 *  widths/bold/fills/alignment match. Editable (unlocked) cells become
 *  inline controls — YELLOW when empty, GREEN when filled — with the
 *  value's source. A bottom info bar explains the focused field. Edits live
 *  in the schema; the .xlsm is written only on "Populate".
 * ============================================================ */
import { h, esc, toast } from "../ui/util";
import { ICON } from "../ui/icons";
import type { MepcSchema, MepcField, MepcSheetSchema, MepcGridCell } from "../engine/mepc-schema";
import { numToCol } from "../engine/mepc-schema";
import { populateMepc, isWritable } from "../engine/mepc-populate";

export interface MepcMockupOpts {
  schema: MepcSchema;
  xlsmBuf: ArrayBuffer;
  projectName?: string;
  onSaveDraft?: (schema: MepcSchema) => void | Promise<void>;
  onDigest?: (files: File[], schema: MepcSchema, refresh: () => void) => void | Promise<void>;
}

const isEmpty = (f: MepcField) => !isWritable(f);
function displayValue(f: MepcField): string {
  if (f.value == null || f.value === "") return "";
  if (f.type === "percent") { const n = typeof f.value === "number" ? f.value : parseFloat(String(f.value)); return isFinite(n) ? String(+(n * 100).toFixed(4)) : String(f.value); }
  return String(f.value);
}

export function openMepcMockup(opts: MepcMockupOpts) {
  const { schema } = opts;
  let active = 0;
  const fid = (si: number, cell: string) => `mm-${si}-${cell}`;
  const countFilled = () => { let f = 0, t = 0; for (const s of schema.sheets) for (const fl of s.fields) { t++; if (!isEmpty(fl)) f++; } return { f, t }; };

  const overlay = h(`
    <div class="modal-overlay mm-overlay">
      <div class="modal mm-modal">
        <div class="modal-hd"><h3>Fill MEPC Calculator${opts.projectName ? " — " + esc(opts.projectName) : ""}</h3>
          <span class="mm-count" id="mm-count"></span><span class="x" id="mm-x">${ICON.close("x")}</span></div>

        <div class="mm-digest">
          <div class="mm-digest-hd">${ICON.files("x").replace('class="nav-ico"', 'class="x" style="width:15px;height:15px;stroke:var(--red);fill:none;stroke-width:2"')}<b>Digest files</b><span class="muted-tag">upload supporting docs — matching values are mapped into the cells below (regex + AI), sources kept</span></div>
          <div class="mm-digest-row"><input type="file" id="mm-digest-files" multiple /><button class="btn btn-sm" id="mm-digest-go">${ICON.bolt()} Parse &amp; map</button><span class="muted-tag" id="mm-digest-note"></span></div>
        </div>

        <div class="mm-toolbar">
          <button class="btn btn-sm" id="mm-next">${ICON.chevron("x")} Next empty field</button>
          <input class="mm-search" id="mm-search" placeholder="Find a field by label…" />
          <div class="mm-legend"><span class="mm-chip empty">empty input</span><span class="mm-chip filled">filled</span><span class="mm-chip cond">conditional row</span></div>
        </div>

        <div class="mm-tabs" id="mm-tabs"></div>
        <div class="mm-body" id="mm-body"></div>
        <div class="mm-info" id="mm-info">Click a yellow/green cell to see what it is.</div>

        <div class="mm-footer">
          <button class="btn" id="mm-draft">Save as draft</button>
          <div style="flex:1"></div>
          <span class="muted-tag" id="mm-foot-note"></span>
          <button class="btn btn-primary" id="mm-populate">${ICON.download()} Populate &amp; download .xlsm</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
  const close = () => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector("#mm-x")!.addEventListener("click", close);

  const tabsEl = overlay.querySelector("#mm-tabs") as HTMLElement;
  const bodyEl = overlay.querySelector("#mm-body") as HTMLElement;
  const countEl = overlay.querySelector("#mm-count") as HTMLElement;
  const infoEl = overlay.querySelector("#mm-info") as HTMLElement;

  const paintCount = () => { const { f, t } = countFilled(); countEl.textContent = `${f} / ${t} fields filled`; };
  const renderTabBadges = () => schema.sheets.forEach((s, i) => {
    const b = tabsEl.querySelector(`.mm-tab[data-i="${i}"] .mm-tab-badge`) as HTMLElement | null; if (!b) return;
    const empty = s.fields.filter(isEmpty).length; b.textContent = `${s.fields.length - empty}/${s.fields.length}`; b.classList.toggle("done", empty === 0);
  });
  const renderTabs = () => {
    tabsEl.innerHTML = schema.sheets.map((s, i) => {
      const empty = s.fields.filter(isEmpty).length;
      return `<button class="mm-tab ${i === active ? "active" : ""}" data-i="${i}">${esc(s.name)}<span class="mm-tab-badge ${empty ? "" : "done"}">${s.fields.length - empty}/${s.fields.length}</span></button>`;
    }).join("");
    tabsEl.querySelectorAll<HTMLElement>(".mm-tab").forEach((t) => t.addEventListener("click", () => { active = +t.dataset.i!; renderTabs(); renderBody(); }));
  };

  const showInfo = (f: MepcField) => {
    const opts = f.options?.length ? ` · options: ${f.options.slice(0, 8).map(esc).join(" / ")}${f.options.length > 8 ? "…" : ""}` : "";
    const src = !isEmpty(f) && f.source ? ` · <b style="color:#166534">source: ${esc(f.source)}</b>` : "";
    infoEl.innerHTML = `<b>${esc(f.label || "(unlabeled)")}</b> <span class="mm-info-ref">cell ${f.cell} · ${esc(f.type)}</span>${opts}${src}`;
  };

  const controlHtml = (f: MepcField, id: string): string => {
    if (f.type === "dropdown" || f.type === "checkbox") {
      const opts = (f.options || []).map((o) => `<option value="${esc(o)}" ${String(f.value) === o ? "selected" : ""}>${esc(o)}</option>`).join("");
      return `<select class="mm-cell-input" id="${id}" data-cell="${f.cell}"><option value=""></option>${opts}</select>`;
    }
    const type = (f.type === "number" || f.type === "percent") ? "number" : "text";
    const step = f.type === "percent" ? ' step="0.1"' : (f.type === "number" ? ' step="any"' : "");
    return `<input class="mm-cell-input" id="${id}" type="${type}"${step} value="${esc(displayValue(f))}" data-cell="${f.cell}" title="${esc(f.label)} (${f.cell})" />${f.type === "percent" ? '<span class="mm-pct">%</span>' : ""}`;
  };

  const renderSheet = (sheet: MepcSheetSchema): string => {
    const g = sheet.grid;
    const fieldByCell = new Map(sheet.fields.map((f) => [f.cell, f]));
    const colgroup = `<colgroup><col style="width:34px">${g.cols.map((c) => `<col style="width:${g.colWidths[c]}px">`).join("")}</colgroup>`;
    const header = `<tr class="mm-xl-head"><th></th>${g.cols.map((c) => `<th>${numToCol(c)}</th>`).join("")}</tr>`;
    const byRow = new Map<number, MepcGridCell[]>();
    for (const cell of g.cells) { const a = byRow.get(cell.r) || []; a.push(cell); byRow.set(cell.r, a); }
    const body = g.rows.map((r) => {
      const cells = (byRow.get(r) || []).sort((a, b) => a.c - b.c);
      const tds = cells.map((cell) => {
        const span = `${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ""}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ""}`;
        if (cell.input && cell.fieldCell) {
          const f = fieldByCell.get(cell.fieldCell); if (!f) return `<td${span}></td>`;
          const filled = !isEmpty(f);
          return `<td${span} class="mm-in ${filled ? "filled" : "empty"}" data-fc="${cell.fieldCell}">${controlHtml(f, fid(active, cell.fieldCell))}</td>`;
        }
        const st: string[] = [];
        if (cell.fill && cell.fill !== "#FFFFFF") st.push(`background:${cell.fill}`);
        if (cell.bold) st.push("font-weight:700");
        if (cell.align) st.push(`text-align:${cell.align}`);
        const style = st.length ? ` style="${st.join(";")}"` : "";
        return `<td${span} class="mm-lbl"${style} title="${esc(cell.text)}">${esc(cell.text)}</td>`;
      }).join("");
      const rowHidden = cells.length > 0 && cells[0].hidden;
      return `<tr class="${rowHidden ? "mm-rowhidden" : ""}"><th class="mm-xl-rownum"${rowHidden ? ' title="conditional row — collapsed in Excel"' : ""}>${r}</th>${tds}</tr>`;
    }).join("");
    return `<table class="mm-xl">${colgroup}<thead>${header}</thead><tbody>${body}</tbody></table>`;
  };

  const wireInputs = () => {
    const sheet = schema.sheets[active];
    for (const f of sheet.fields) {
      const id = fid(active, f.cell);
      const input = overlay.querySelector("#" + CSS.escape(id)) as HTMLInputElement | HTMLSelectElement | null;
      if (!input) continue;
      const td = input.closest("td") as HTMLElement;
      const onEdit = () => {
        const raw = input.value.trim();
        if (raw === "") { f.value = null; f.filled = false; f.source = undefined; }
        else {
          if (f.type === "percent") { const n = parseFloat(raw); f.value = isFinite(n) ? n / 100 : raw; }
          else if (f.type === "number") { const n = parseFloat(raw.replace(/,/g, "")); f.value = isFinite(n) ? n : raw; }
          else { const num = raw.replace(/,/g, ""); f.value = /^-?\d*\.?\d+$/.test(num) && isFinite(+num) ? +num : raw; }
          f.filled = true; f.source = "Manual edit";
        }
        const empty = isEmpty(f);
        td?.classList.toggle("filled", !empty); td?.classList.toggle("empty", empty);
        showInfo(f); paintCount(); renderTabBadges();
      };
      input.addEventListener("change", onEdit);
      input.addEventListener("focus", () => showInfo(f));
      if (input instanceof HTMLInputElement) input.addEventListener("input", onEdit);
    }
  };

  const renderBody = () => { bodyEl.innerHTML = renderSheet(schema.sheets[active]); wireInputs(); };

  // ---- next empty field (current tab forward, then following tabs) ----
  const focusField = (si: number, f: MepcField) => {
    if (si !== active) { active = si; renderTabs(); renderBody(); }
    const id = fid(si, f.cell);
    const input = overlay.querySelector("#" + CSS.escape(id)) as HTMLElement | null;
    const td = input?.closest("td") as HTMLElement;
    td?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    td?.classList.add("flash"); setTimeout(() => td?.classList.remove("flash"), 1200);
    (input as HTMLInputElement)?.focus(); if (input) showInfo(f);
  };
  overlay.querySelector("#mm-next")!.addEventListener("click", () => {
    for (let k = 0; k < schema.sheets.length; k++) { const si = (active + k) % schema.sheets.length; const f = schema.sheets[si].fields.find(isEmpty); if (f) return focusField(si, f); }
    toast("✓ All fields are filled");
  });
  const searchEl = overlay.querySelector("#mm-search") as HTMLInputElement;
  const doSearch = () => {
    const q = searchEl.value.trim().toLowerCase(); if (!q) return;
    for (let k = 0; k < schema.sheets.length; k++) { const si = (active + k) % schema.sheets.length; const f = schema.sheets[si].fields.find((x) => x.label.toLowerCase().includes(q) || x.cell.toLowerCase() === q); if (f) return focusField(si, f); }
    toast("No field matches “" + searchEl.value + "”");
  };
  searchEl.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") doSearch(); });

  // ---- digest / draft / populate ----
  overlay.querySelector("#mm-digest-go")!.addEventListener("click", async () => {
    const files = [...((overlay.querySelector("#mm-digest-files") as HTMLInputElement).files || [])];
    const note = overlay.querySelector("#mm-digest-note") as HTMLElement;
    if (!files.length) { note.textContent = "pick one or more files first"; return; }
    if (!opts.onDigest) { note.textContent = "file mapping not available here"; return; }
    note.innerHTML = `<span class="spinner" style="width:11px;height:11px;vertical-align:middle"></span> mapping…`;
    try { await opts.onDigest(files, schema, () => { renderBody(); renderTabBadges(); paintCount(); }); note.textContent = "✓ mapped — see the highlighted cells"; }
    catch (e: any) { note.textContent = "✗ " + (e?.message || e); }
  });
  overlay.querySelector("#mm-draft")!.addEventListener("click", async () => {
    try { if (opts.onSaveDraft) { await opts.onSaveDraft(schema); toast("✓ Draft saved"); } else toast("Draft saving unavailable"); }
    catch (e: any) { toast("Draft failed — " + (e?.message || e)); }
  });
  overlay.querySelector("#mm-populate")!.addEventListener("click", async () => {
    const btn = overlay.querySelector("#mm-populate") as HTMLButtonElement;
    const note = overlay.querySelector("#mm-foot-note") as HTMLElement;
    btn.disabled = true; note.textContent = "writing .xlsm…";
    try {
      const { blob, name, written } = await populateMepc(opts.xlsmBuf, schema, opts.projectName);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      note.textContent = `✓ wrote ${written} cells → ${name}`; toast("✓ .xlsm populated & downloaded");
    } catch (e: any) { note.textContent = "✗ " + (e?.message || e); }
    finally { btn.disabled = false; }
  });

  renderTabs(); renderBody(); paintCount();
}
