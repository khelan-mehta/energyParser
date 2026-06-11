/* ============================================================
 *  Auth screen — login / signup / pending-approval.
 * ============================================================ */
import { Auth, setToken, setAuthUser } from "../api";
import { h, esc, toast } from "../ui/util";

export function renderAuth(app: HTMLElement, onAuthed: () => void) {
  let mode: "login" | "signup" = "login";
  let pending = false;

  function paint() {
    app.innerHTML = "";
    const wrap = h(`<div class="auth-wrap"></div>`);
    const card = h(`
      <div class="auth-card">
        <div class="auth-brand"><div class="brand-mark" style="width:44px;height:44px;font-size:24px">M</div><div><div class="auth-name">Marcus</div><div class="auth-tag">Energy Model Studio</div></div></div>
        ${pending ? pendingHtml() : formHtml(mode)}
      </div>
    `);
    wrap.appendChild(card);
    app.appendChild(wrap);
    if (!pending) wire(card);
    else card.querySelector("#back")!.addEventListener("click", () => { pending = false; mode = "login"; paint(); });
  }

  function formHtml(m: "login" | "signup"): string {
    return `
      <h2 class="auth-h">${m === "login" ? "Welcome back" : "Create your account"}</h2>
      <p class="auth-sub">${m === "login" ? "Sign in to your projects." : "New accounts are approved by an admin."}</p>
      <div class="auth-form">
        ${m === "signup" ? `<div class="field"><label>Full name</label><input id="au-name" placeholder="Jane Modeler" /></div>` : ""}
        <div class="field"><label>Email</label><input id="au-email" type="email" placeholder="you@firm.com" autocomplete="username" /></div>
        <div class="field"><label>Password</label><input id="au-pass" type="password" placeholder="••••••••" autocomplete="${m === "login" ? "current-password" : "new-password"}" /></div>
        <button class="btn btn-primary" id="au-submit" style="width:100%;justify-content:center;margin-top:6px">${m === "login" ? "Sign in" : "Sign up"}</button>
        <div class="auth-switch">${m === "login" ? `No account? <a id="au-toggle">Sign up</a>` : `Have an account? <a id="au-toggle">Sign in</a>`}</div>
        <div class="auth-err" id="au-err"></div>
      </div>`;
  }
  function pendingHtml(): string {
    return `
      <div style="text-align:center;padding:10px 0 4px">
        <div style="font-size:42px;margin-bottom:8px">⏳</div>
        <h2 class="auth-h">Awaiting approval</h2>
        <p class="auth-sub">Your account was created and is pending admin approval. You'll be able to sign in once approved.</p>
        <button class="btn" id="back" style="margin-top:14px">Back to sign in</button>
      </div>`;
  }

  function wire(card: HTMLElement) {
    const err = card.querySelector("#au-err")!;
    card.querySelector("#au-toggle")?.addEventListener("click", () => { mode = mode === "login" ? "signup" : "login"; paint(); });
    const submit = card.querySelector("#au-submit") as HTMLButtonElement;
    const go = async () => {
      err.textContent = "";
      const email = (card.querySelector("#au-email") as HTMLInputElement).value.trim();
      const pass = (card.querySelector("#au-pass") as HTMLInputElement).value;
      const name = (card.querySelector("#au-name") as HTMLInputElement)?.value.trim() || "";
      if (!email || !pass) { err.textContent = "Email and password required."; return; }
      submit.disabled = true; submit.innerHTML = `<span class="spinner"></span>`;
      try {
        const res = mode === "login" ? await Auth.login(email, pass) : await Auth.signup(email, pass, name);
        if (res.token) { setToken(res.token); setAuthUser(res.user); toast(`Welcome, ${res.user.name}`); onAuthed(); return; }
        if (res.pending) { pending = true; paint(); return; }
      } catch (e: any) {
        if (e.data?.pending) { pending = true; paint(); return; }
        err.textContent = e.message || "Something went wrong.";
      } finally { submit.disabled = false; submit.innerHTML = mode === "login" ? "Sign in" : "Sign up"; }
    };
    submit.addEventListener("click", go);
    card.querySelectorAll("input").forEach((i) => i.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") go(); }));
  }

  paint();
}
