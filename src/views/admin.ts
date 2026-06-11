/* ============================================================
 *  Admin — user approval & role management.
 * ============================================================ */
import { Users, User, authUser } from "../api";
import { h, esc, toast } from "../ui/util";

export async function renderAdmin(root: HTMLElement) {
  root.appendChild(h(`<div class="page-head"><div><h1>Admin</h1><p>Approve new sign-ups and manage roles.</p></div></div>`));
  if (authUser?.role !== "admin") { root.appendChild(h(`<div class="card"><div class="empty"><div class="big">🔒</div><div style="color:var(--g500)">Admins only.</div></div></div>`)); return; }

  const card = h(`<div class="card"><div class="card-hd"><h3>Users</h3><span class="sub" id="ad-count"></span></div><div id="ad-list"></div></div>`);
  root.appendChild(card);
  const list = card.querySelector("#ad-list")!;
  try {
    const { users } = await Users.list();
    card.querySelector("#ad-count")!.textContent = `${users.length} total · ${users.filter((u: User) => u.status === "pending").length} pending`;
    (users as User[]).sort((a, b) => (a.status === "pending" ? -1 : 1) - (b.status === "pending" ? -1 : 1) || b.createdAt - a.createdAt)
      .forEach((u) => list.appendChild(userRow(root, u)));
  } catch (e: any) { list.appendChild(h(`<div class="source-note" style="border-left-color:var(--red)">${esc(e.message)}</div>`)); }
}

function userRow(root: HTMLElement, u: User): HTMLElement {
  const initials = (u.name || u.email).slice(0, 1).toUpperCase();
  const row = h(`
    <div class="user-row">
      <div class="u-av">${esc(initials)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13.5px">${esc(u.name)} ${u.role === "admin" ? `<span class="pill pill-red" style="font-size:9px">admin</span>` : ""}</div>
        <div style="font-size:11.5px;color:var(--g400)">${esc(u.email)}</div>
      </div>
      <span class="status-pill st-${u.status}">${esc(u.status)}</span>
      <div style="display:flex;gap:6px" class="u-actions"></div>
    </div>
  `);
  const act = row.querySelector(".u-actions")!;
  const me = authUser?.id === u.id;
  if (u.status === "pending") {
    act.appendChild(btn("Approve", "btn-primary", async () => { await Users.action(u.id, "approve"); toast("Approved"); rerender(root); }));
    act.appendChild(btn("Reject", "", async () => { await Users.action(u.id, "reject"); toast("Rejected"); rerender(root); }));
  } else if (u.status === "approved" && !me) {
    if (u.role === "user") act.appendChild(btn("Make admin", "", async () => { await Users.action(u.id, "make-admin"); toast("Promoted"); rerender(root); }));
    else act.appendChild(btn("Make user", "", async () => { await Users.action(u.id, "make-user"); toast("Demoted"); rerender(root); }));
  } else if (u.status === "rejected") {
    act.appendChild(btn("Approve", "btn-primary", async () => { await Users.action(u.id, "approve"); toast("Approved"); rerender(root); }));
  }
  return row;
}
function btn(label: string, cls: string, fn: () => void): HTMLElement {
  const b = h(`<button class="btn btn-sm ${cls}">${esc(label)}</button>`);
  b.addEventListener("click", fn);
  return b;
}
function rerender(root: HTMLElement) { root.innerHTML = ""; renderAdmin(root); }
