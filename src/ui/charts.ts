/* Chart.js wrappers themed red / black / grey. */
import {
  Chart, BarController, BarElement, LineController, LineElement, PointElement,
  DoughnutController, ArcElement, PieController, CategoryScale, LinearScale,
  Tooltip, Legend, Filler,
} from "chart.js";

Chart.register(
  BarController, BarElement, LineController, LineElement, PointElement,
  DoughnutController, ArcElement, PieController, CategoryScale, LinearScale,
  Tooltip, Legend, Filler
);

export const PALETTE = ["#E4002B", "#0c0c0d", "#a1a1aa", "#71717a", "#d4d4d8", "#b30022", "#52525b", "#e4e4e7"];

Chart.defaults.font.family = "'Franklin Gothic Book', 'Libre Franklin', 'Segoe UI', Arial, sans-serif";
Chart.defaults.color = "#71717a";
Chart.defaults.font.size = 11;

const registry = new Map<HTMLCanvasElement, Chart>();

export function makeChart(canvas: HTMLCanvasElement, config: any): Chart {
  const old = registry.get(canvas);
  if (old) old.destroy();
  const c = new Chart(canvas, config);
  registry.set(canvas, c);
  return c;
}

export function gridOpts(showLegend = false) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: showLegend, position: "bottom" as const, labels: { boxWidth: 10, boxHeight: 10, padding: 14, usePointStyle: true } },
      tooltip: { backgroundColor: "#0c0c0d", padding: 10, cornerRadius: 8, titleFont: { weight: "600" as const } },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false } },
      y: { grid: { color: "#f0f0f1" }, border: { display: false }, ticks: { maxTicksLimit: 6 } },
    },
  };
}
