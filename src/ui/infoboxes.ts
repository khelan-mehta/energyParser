/* Reusable "How to use" + "Expected outcomes" boxes. */
import { h } from "./util";
import { ICON } from "./icons";

export function infoBoxes(how: string[], outcomes: string[]): HTMLElement {
  return h(`
    <div class="info-boxes">
      <div class="info-box">
        <h4><span class="ib-ico">${ICON.info()}</span> How to use — instructions</h4>
        <ol>${how.map((x) => `<li>${x}</li>`).join("")}</ol>
      </div>
      <div class="info-box outcome">
        <h4><span class="ib-ico">${ICON.target()}</span> Expected outcomes</h4>
        <ul>${outcomes.map((x) => `<li>${x}</li>`).join("")}</ul>
      </div>
    </div>`);
}
