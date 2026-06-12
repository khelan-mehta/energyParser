import "./style.css";
import { mountShell, registerRoute } from "./ui/shell";
import { renderDashboard } from "./views/dashboard";
import { renderMarcus } from "./views/marcus";
import { renderMepc } from "./views/mepc";
import { renderWordReport } from "./views/wordreport";
import { renderRates } from "./views/rates";
import { renderLeed } from "./views/leed";
import { renderDocs } from "./views/docs";
import { renderAdmin } from "./views/admin";
import { renderAuth } from "./views/auth";
import { Auth, getToken, setToken, setAuthUser } from "./api";

registerRoute("dashboard", renderDashboard);
registerRoute("marcus", renderMarcus);
registerRoute("mepc", renderMepc);
registerRoute("report", renderWordReport);
registerRoute("rates", renderRates);
registerRoute("leed", renderLeed);
registerRoute("docs", renderDocs);
registerRoute("admin", renderAdmin);

const app = document.getElementById("app")!;

async function boot() {
  app.innerHTML = `<div class="auth-wrap"><div class="spinner" style="width:30px;height:30px"></div></div>`;
  if (getToken()) {
    try { const { user } = await Auth.me(); setAuthUser(user); mountShell(app); return; }
    catch { setToken(null); }
  }
  renderAuth(app, boot);
}

boot();
