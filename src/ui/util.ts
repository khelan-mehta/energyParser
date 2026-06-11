/* Small DOM + format helpers (no framework). */

export function h(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  if (t.content.children.length === 1) return t.content.firstElementChild as HTMLElement;
  // Multiple top-level nodes: wrap transparently so siblings aren't dropped
  // and layout (grid/flex of the parent) is unaffected.
  const wrap = document.createElement("div");
  wrap.style.display = "contents";
  wrap.append(...Array.from(t.content.childNodes));
  return wrap;
}

export function fmt(n: number, d = 0): string {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
}

export function fmtCompact(n: number): string {
  const abs = Math.abs(n || 0);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return fmt(n, 0);
}

let toastTimer: any;
export function toast(msg: string) {
  let t = document.querySelector(".toast") as HTMLElement;
  if (!t) { t = h(`<div class="toast"></div>`); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

export function esc(s: any): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
