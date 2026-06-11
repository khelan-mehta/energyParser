/* ============================================================
 *  LEED District-Energy Guidance view.
 * ============================================================ */
import { LEED_DES_GUIDANCE } from "../engine/rates";
import { h, esc } from "../ui/util";
import { ICON } from "../ui/icons";
import { navigate } from "../ui/shell";

export function renderLeed(root: HTMLElement) {
  const g = LEED_DES_GUIDANCE;
  root.appendChild(h(`
    <div class="page-head">
      <div><h1>LEED Guidance</h1><p>How to treat district thermal energy in your cost &amp; carbon roll-ups.</p></div>
      <div class="actions"><button class="btn btn-dark" id="l-rates">${ICON.rates()} Set district factors</button></div>
    </div>
  `));

  const card = h(`<div class="card"></div>`);
  card.appendChild(h(`<div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.leed("x").replace('class="nav-ico"', 'class="x" style="stroke:var(--red);width:16px;height:16px;fill:none;stroke-width:2"')}</div><h3>${esc(g.title)}</h3></div>`));
  const body = h(`<ul class="guidance" style="list-style:disc"></ul>`);
  g.body.forEach((p) => body.appendChild(h(`<li>${esc(p)}</li>`)));
  card.appendChild(body);
  root.appendChild(card);

  const fcard = h(`<div class="card" style="margin-top:16px"></div>`);
  fcard.appendChild(h(`<div class="card-hd"><h3>Default Factors</h3><span class="sub">use when actual DES plant data is unavailable</span></div>`));
  const flist = h(`<div class="guidance"></div>`);
  g.factors.forEach((f) => flist.appendChild(h(`<div class="factor"><b>${esc(f.label)}</b><span>${esc(f.value)}</span></div>`)));
  fcard.appendChild(flist);
  fcard.appendChild(h(`<div class="source-note" style="margin-top:14px"><b>Source:</b> ${esc(g.source)}</div>`));
  root.appendChild(fcard);

  // two-option explainer
  const opts = h(`<div class="grid cards-2" style="margin-top:16px"></div>`);
  opts.appendChild(h(`
    <div class="card"><div class="card-hd"><span class="pill pill-red">Option 1</span><h3 style="margin-left:6px">Default</h3></div>
    <p style="font-size:13px;color:var(--g600);line-height:1.6">Model the district system as a virtual on-site plant using LEED default efficiencies and emission/source factors. Lowest documentation burden; conservative.</p></div>
  `));
  opts.appendChild(h(`
    <div class="card"><div class="card-hd"><span class="pill pill-black">Option 2</span><h3 style="margin-left:6px">Actual</h3></div>
    <p style="font-size:13px;color:var(--g600);line-height:1.6">Use the real plant's measured efficiency, fuel mix, and published emission factors. Required to claim credit for an efficient or low-carbon district plant.</p></div>
  `));
  root.appendChild(opts);

  root.querySelector("#l-rates")!.addEventListener("click", () => navigate("rates"));
}
