/* ============================================================
 *  Documentation — a single red surface, white text. A Marcus
 *  Aurelius ASCII portrait whose eyes ARE ascii: carved into
 *  the character grid and redrawn, cell by cell, as the cursor
 *  moves. The documentation flows seamlessly around him.
 * ============================================================ */
import { h, esc } from "../ui/util";
import ART from "./marcus-aurelius.txt?raw";

/* ---- Eye geometry --------------------------------------------------
 * Each eye is an EYE_W × EYE_H block of characters spliced into the
 * portrait grid. { row, col } is the character cell of the eye's
 * CENTRE (row = line index, col = column, both 0-based). Nudge by ±1
 * cell if they don't sit on his eyes in your font. */
const EYE_W = 5;
const EYE_H = 3;
const EYES = [
  { row: 24, col: 29 }, // his right eye (screen-left)
  { row: 22, col: 50 }, // his left eye  (screen-right)
];
const BOXES = EYES.map((e, i) => ({
  i,
  row0: e.row - (EYE_H >> 1),
  col0: e.col - (EYE_W >> 1),
}));

/* The portrait as a rectangular character grid. */
const GRID: string[] = (() => {
  const lines = ART.replace(/\r/g, "").split("\n");
  const w = Math.max(...lines.map((l) => l.length));
  return lines.map((l) => l.padEnd(w, " "));
})();

/* One eye, EYE_H rows × EYE_W chars. dx ∈ [-3..3] cells, dy ∈ [-1..1]
 * rows, relative to looking straight out of the page.
 *
 *   .-=======-.      .-===@===-.      .-=======-.
 *   (   (@)   )      (         )      ( ------- )
 *   '-=======-'      '-=======-'      '-=======-'
 *     centred          rolled up          blink                     */
function eyeSprite(dx: number, dy: number, blink = false): string[] {
  const inner = EYE_W - 2;                          // chars between the frame
  const rows = [
    ("." + "#".repeat(inner) + ".").split(""),      // upper lid
    ("#" + " ".repeat(inner) + "#").split(""),      // open eye
    ("'" + "#".repeat(inner) + "'").split(""),      // lower lid
  ];
  if (blink) return [rows[0].join(""), "(" + "-".repeat(inner) + ")", rows[2].join("")];
  const halfX = EYE_W >> 1, maxDx = halfX - 1;       // keep the pupil inside the frame
  const halfY = EYE_H >> 1, maxDy = halfY;           // ...and onto the lids vertically
  const cx = halfX + Math.max(-maxDx, Math.min(maxDx, Math.round(dx)));
  const cy = halfY + Math.max(-maxDy, Math.min(maxDy, Math.round(dy)));
  rows[cy][cx] = "O";                                // pupil roams x and y
  return rows.map((r) => r.join(""));
}

/* Escape the art and cut span "windows" where the eyes live. The spans
 * are filled (and refilled) with eyeSprite() text at runtime. */
function artHtml(): string {
  return GRID.map((line, r) => {
    const boxes = BOXES
      .filter((b) => r >= b.row0 && r < b.row0 + EYE_H)
      .sort((a, b) => a.col0 - b.col0);
    if (!boxes.length) return esc(line);
    let out = "";
    let cur = 0;
    for (const b of boxes) {
      out += esc(line.slice(cur, b.col0));
      out += `<span class="ma-eye" data-eye="${b.i}" data-row="${r - b.row0}"></span>`;
      cur = b.col0 + EYE_W;
    }
    return out + esc(line.slice(cur));
  }).join("\n");
}

export function renderDocs(root: HTMLElement) {
  /* Proof-of-life. If this never appears in the console, the router is
   * still importing the OLD docs module — this file isn't running.
   * Delete this line once you've seen it. */
  console.info("%c[docs] ASCII-eye module active", "color:#E4002B;font-weight:bold");

  root.appendChild(h(`<div class="page-head"><div><h1>Documentation</h1><p>The Marcus studio, end to end. He is watching you read.</p></div></div>`));

  const panel = h(`
    <div class="docs-red">
      <div class="docs-hero">
        <div class="dr-art">
          <div class="ma-stage">
            <pre class="ma-pre">${artHtml()}</pre>
          </div>
        </div>
        <div class="dr-copy">
          <div class="dr-kicker">Marcvs Aurelius · Imperator · Philosophus</div>
          <h2>The Marcus studio</h2>
          <p>A browser-native workspace that parses building-energy models, sources utility rates with citations, and fills LEED compliance workbooks — every computation runs in your hands, named for the emperor who prized clear reckoning over noise.</p>
          <blockquote class="dr-quote">You have power over your mind — not outside events. Realize this, and you will find strength.</blockquote>
        </div>
      </div>

      <div class="dr-rule"></div>

      <div class="dr-modules">
        <h3>Modules</h3>
        <div class="dr-list">
          ${mod("Dashboard", "Your project portfolio — EUI, totals and quick re-entry into any model.")}
          ${mod("Marcus", "Upload baseline and proposed .SIM / .inp (or a TRACE PDF), parse, review the dashboards, then export a styled Excel workbook. AI search pulls any value from the parsed model.")}
          ${mod("MEPC", "Standalone .SIM to LEED v4 Minimum Energy Performance Calculator — clean copy-paste tables across four rotations, envelope and lighting, plus an experimental direct .xlsm fill.")}
          ${mod("Utility Rates", "Locate a project and auto-source electricity, gas, carbon and water rates from EIA, NREL and EPA — ranked by reliability, with a timestamped rate-history trend.")}
          ${mod("LEED Guidance", "On-hand references for the credits the workbooks target.")}
          ${mod("Admin", "User approvals and roles, for administrators.")}
        </div>

        <h3 style="margin-top:24px">The path</h3>
        <div class="dr-flow">
          ${["Create project", "Upload model files", "Parse", "Source rates", "Review analysis", "Export / fill MEPC"].map((s, i) => `<span class="step"><b>${String(i + 1).padStart(2, "0")}</b> ${esc(s)}</span>`).join('<span class="sep">—</span>')}
        </div>

        <div class="dr-foot">
          <span>Vite · TypeScript · Express · Chart.js · xlsx-js-style · JSZip</span>
          <span>All parsing runs in your browser; files never leave the box except for rate lookups.</span>
        </div>
      </div>
    </div>`);

  root.appendChild(panel);
  trackEyes(panel);
}

function mod(name: string, body: string): string {
  return `<div class="dr-item"><div class="dr-name">${esc(name)}</div><div class="dr-body">${esc(body)}</div></div>`;
}

/* The eyes are text. On mouse move we work out, per eye, which character
 * cell the pupil should occupy (quantised — so the art itself changes,
 * stepping from cell to cell) and rewrite just those three rows.
 * Listener and blink timer self-remove once the portrait leaves the DOM. */
function trackEyes(scope: HTMLElement) {
  /* Belt and braces: if a stale render of the old module left its ●
   * overlay spans anywhere in the document, remove them. */
  document.querySelectorAll(".ma-pupil").forEach((n) => n.remove());

  const spans = Array.from(scope.querySelectorAll(".ma-eye")) as HTMLElement[];
  const eyes = EYES.map((_, i) => ({
    rows: spans
      .filter((s) => s.dataset.eye === String(i))
      .sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row)),
    dx: 0,
    dy: 0,
  }));
  let blink = false;

  const paint = () => {
    for (const e of eyes) {
      const art = eyeSprite(e.dx, e.dy, blink);
      e.rows.forEach((s, r) => {
        // Wrap the pupil glyph so it can glow gold; the rest is plain text.
        const html = art[r].replace(/@/g, '<span class="ma-iris">@</span>');
        if (s.innerHTML !== html) s.innerHTML = html;
      });
    }
  };

  let raf = 0;
  let idleTimer: ReturnType<typeof setTimeout>;
  const recenter = () => {                         // ease the gaze back to forward
    if (!document.body.contains(scope)) return;
    let changed = false;
    for (const e of eyes) if (e.dx || e.dy) { e.dx = 0; e.dy = 0; changed = true; }
    if (changed) paint();
  };
  const onMove = (ev: MouseEvent) => {
    if (!document.body.contains(scope)) {
      window.removeEventListener("mousemove", onMove);
      clearInterval(blinkTimer);
      clearTimeout(idleTimer);
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(recenter, 1800);        // after a still moment, look forward again
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      let changed = false;
      for (const e of eyes) {
        const midRow = e.rows[1];
        if (!midRow) continue;
        const r = midRow.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const ang = Math.atan2(ev.clientY - cy, ev.clientX - cx);
        /* Full deflection once the cursor is ~160px away; tweak to taste. */
        const amp = Math.min(1, Math.hypot(ev.clientX - cx, ev.clientY - cy) / 160);
        const dx = Math.round(Math.cos(ang) * 3 * amp);
        const dy = Math.round(Math.sin(ang) * 1.2 * amp);
        if (dx !== e.dx || dy !== e.dy) { e.dx = dx; e.dy = dy; changed = true; }
      }
      if (changed) paint();
    });
  };
  window.addEventListener("mousemove", onMove);

  /* An occasional blink, because he is alive. Delete this block if not. */
  const blinkTimer = setInterval(() => {
    if (!document.body.contains(scope)) { clearInterval(blinkTimer); return; }
    blink = true; paint();
    setTimeout(() => { blink = false; paint(); }, 130);
  }, 4200);

  paint(); // first fill — eyes forward
}