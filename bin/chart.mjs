// Render the cohort chart as a standalone SVG from docs/cohort-<n>-*.json.
//
// The figure is GENERATED, never hand-edited. It reads the same numbers the
// JSON reports carry, so a re-run of the eval updates the picture by
// regenerating it, and a chart cannot silently drift from results/.
//
// Usage:  node bin/chart.mjs docs/cohort-1-local-small.json [out.svg]
//
// No dependencies, no build step: this emits SVG text directly so the file
// renders in a browser, in GitHub, and in any Markdown viewer without a
// rasteriser.

import { readFileSync, writeFileSync } from "node:fs";

const W = 1040;
const H = 560;
const M = { top: 56, right: 300, bottom: 68, left: 76 };

const INK = "#14161a";
const MUTED = "#6b7280";
const GRID = "#e5e7eb";
const AXIS = "#9ca3af";
const FRONTIER = "#c2410c";
const DOMINATED = "#b6bcc6";
const ORACLE = "#166534";
const ORACLE_Y = 100;

// Score bands, so a reader can see where the cohort sits rather than only
// where each point landed. Mirrors the bands in the README rubric.
const BANDS = [
  { from: 0, to: 20, fill: "#fdf2f2" },
  { from: 20, to: 40, fill: "#fffbeb" },
  { from: 40, to: 60, fill: "#f0fdf4" },
  { from: 60, to: 80, fill: "#eff6ff" },
  { from: 80, to: 100, fill: "#faf5ff" },
];

/**
 * Points on the Pareto frontier: not dominated by any other point.
 *
 * A point is dominated when another is at least as good on both axes and
 * strictly better on one — cheaper at equal-or-better score, or better-scoring
 * at equal-or-lower cost. Equal cost and equal score is a tie, not domination,
 * so both survive.
 */
export const paretoFrontier = (pts) =>
  pts.filter(
    (p) =>
      !pts.some(
        (q) =>
          q !== p &&
          q.paramsB <= p.paramsB &&
          q.adjusted >= p.adjusted &&
          (q.paramsB < p.paramsB || q.adjusted > p.adjusted)
      )
  );

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const render = (data) => {
  const pts = [...data.points].sort((a, b) => a.paramsB - b.paramsB);
  const maxX = Math.max(...pts.map((p) => p.paramsB)) * 1.12;
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const sx = (v) => M.left + (v / maxX) * plotW;
  const sy = (v) => M.top + plotH - (v / ORACLE_Y) * plotH;

  const frontier = new Set(paretoFrontier(pts).map((p) => p.model));
  const ordered = [...pts].sort((a, b) => a.paramsB - b.paramsB);

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`);
  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

  // Score bands behind the plot.
  for (const b of BANDS) {
    out.push(
      `<rect x="${M.left}" y="${sy(b.to)}" width="${plotW}" height="${sy(b.from) - sy(b.to)}" fill="${b.fill}"/>`
    );
  }

  // Axes.
  out.push(`<line x1="${M.left}" y1="${sy(0)}" x2="${M.left + plotW}" y2="${sy(0)}" stroke="${AXIS}" stroke-width="1"/>`);
  out.push(`<line x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${sy(0)}" stroke="${AXIS}" stroke-width="1"/>`);

  for (let v = 0; v <= 100; v += 20) {
    out.push(`<line x1="${M.left}" y1="${sy(v)}" x2="${M.left + plotW}" y2="${sy(v)}" stroke="${GRID}" stroke-width="1"/>`);
    out.push(`<text x="${M.left - 12}" y="${sy(v) + 4}" text-anchor="end" font-size="12" fill="${MUTED}">${v}</text>`);
  }

  // The oracle's ceiling: unreachable by any model, so the gap is the point.
  out.push(
    `<line x1="${M.left}" y1="${sy(ORACLE_Y)}" x2="${M.left + plotW}" y2="${sy(ORACLE_Y)}" stroke="${ORACLE}" stroke-width="1.5" stroke-dasharray="5 4"/>`
  );

  // X gridlines and integer ticks (parameter counts are integers in billions).
  const xMaxTick = Math.floor(maxX);
  for (let t = 0; t <= xMaxTick; t++) {
    out.push(`<line x1="${sx(t)}" y1="${sy(0)}" x2="${sx(t)}" y2="${sy(ORACLE_Y)}" stroke="${GRID}" stroke-width="1"/>`);
    out.push(`<text x="${sx(t)}" y="${sy(0) + 22}" text-anchor="middle" font-size="12" fill="${MUTED}">${t}</text>`);
  }

  // Frontier staircase: a right-then-up step through the non-dominated points.
  const fp = ordered.filter((p) => frontier.has(p.model));
  let d = "";
  fp.forEach((p, i) => {
    if (i === 0) d += `M ${sx(p.paramsB)} ${sy(p.adjusted)}`;
    else d += ` L ${sx(p.paramsB)} ${sy(fp[i - 1].adjusted)} L ${sx(p.paramsB)} ${sy(p.adjusted)}`;
  });
  if (d) out.push(`<path d="${d}" fill="none" stroke="${FRONTIER}" stroke-width="2" stroke-dasharray="6 4" opacity="0.85"/>`);

  // Points, then labels. Dominated points are hollow so the eye lands on the
  // frontier first.
  for (const p of ordered) {
    const on = frontier.has(p.model);
    const x = sx(p.paramsB);
    const y = sy(p.adjusted);
    const fill = on ? FRONTIER : "#ffffff";
    const stroke = on ? FRONTIER : DOMINATED;
    out.push(`<circle cx="${x}" cy="${y}" r="6.5" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    // Score beside each point, so the plot is readable without the legend.
    out.push(
      `<text x="${x}" y="${y - 14}" text-anchor="middle" font-size="11.5" font-weight="600" fill="${on ? FRONTIER : MUTED}">${p.adjusted}</text>`
    );
  }

  // Legend / detail column.
  let ly = M.top + 4;
  out.push(`<text x="${M.left + plotW + 26}" y="${ly}" font-size="12" font-weight="600" fill="${INK}">model</text>`);
  out.push(`<text x="${W - 24}" y="${ly}" font-size="12" font-weight="600" fill="${INK}" text-anchor="end">SEE · MI · DO · adj</text>`);
  ly += 8;
  out.push(`<line x1="${M.left + plotW + 20}" y1="${ly}" x2="${W - 20}" y2="${ly}" stroke="${GRID}" stroke-width="1"/>`);
  ly += 20;

  for (const p of ordered) {
    const on = frontier.has(p.model);
    out.push(`<circle cx="${M.left + plotW + 32}" cy="${ly - 4}" r="5" fill="${on ? FRONTIER : "#ffffff"}" stroke="${on ? FRONTIER : DOMINATED}" stroke-width="2"/>`);
    out.push(`<text x="${M.left + plotW + 44}" y="${ly}" font-size="11.5" fill="${on ? INK : MUTED}" font-weight="${on ? 600 : 400}">${esc(p.label)}</text>`);
    out.push(
      `<text x="${W - 24}" y="${ly}" font-size="11.5" fill="${on ? INK : MUTED}" text-anchor="end" font-weight="${on ? 600 : 400}">${p.see} · ${p.monkeyIndex} · ${p.do} · ${p.adjusted}</text>`
    );
    ly += 19;
  }

  ly += 6;
  out.push(`<line x1="${M.left + plotW + 20}" y1="${ly - 12}" x2="${W - 20}" y2="${ly - 12}" stroke="${GRID}" stroke-width="1"/>`);
  out.push(`<line x1="${M.left + plotW + 32}" y1="${ly}" x2="${M.left + plotW + 52}" y2="${ly}" stroke="${FRONTIER}" stroke-width="2" stroke-dasharray="5 3"/>`);
  out.push(`<text x="${M.left + plotW + 60}" y="${ly + 4}" font-size="11.5" fill="${INK}">Pareto frontier</text>`);
  out.push(`<circle cx="${M.left + plotW + 42}" cy="${ly + 24}" r="5" fill="#ffffff" stroke="${DOMINATED}" stroke-width="2"/>`);
  out.push(`<text x="${M.left + plotW + 60}" y="${ly + 28}" font-size="11.5" fill="${MUTED}">dominated</text>`);
  out.push(`<line x1="${M.left + plotW + 24}" y1="${ly + 46}" x2="${M.left + plotW + 60}" y2="${ly + 46}" stroke="${ORACLE}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
  out.push(`<text x="${M.left + plotW + 68}" y="${ly + 50}" font-size="11.5" fill="${MUTED}">reference solver</text>`);

  // Titles.
  out.push(`<text x="${M.left}" y="26" font-size="15" font-weight="600" fill="${INK}">${esc(data.cohort)}</text>`);
  out.push(
    `<text x="${M.left}" y="44" font-size="12" fill="${MUTED}">adjusted score (0-100) vs parameters · ${esc(data.date)} · ${data.runs} runs at temperature 0</text>`
  );
  out.push(`<text x="${M.left + plotW / 2}" y="${H - 18}" text-anchor="middle" font-size="12" fill="${MUTED}">parameters (billions)</text>`);
  out.push(
    `<text x="20" y="${M.top + plotH / 2}" text-anchor="middle" font-size="12" fill="${MUTED}" transform="rotate(-90 20 ${M.top + plotH / 2})">adjusted score (0-100)</text>`
  );

  out.push("</svg>");
  return out.join("\n");
};

const [, , input, outputArg] = process.argv;
if (!input) {
  console.error("usage: node bin/chart.mjs docs/cohort-1-local-small.json [out.svg]");
  process.exit(1);
}
const data = JSON.parse(readFileSync(input, "utf8"));
const svg = render(data);
const outPath = outputArg ?? input.replace(/\.json$/, ".svg");
writeFileSync(outPath, svg + "\n");
console.log(`wrote ${outPath} (${data.points.length} points)`);