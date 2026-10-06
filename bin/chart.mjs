// Render the cohort chart as a standalone SVG from docs/cohort-<n>-*.json.
//
// The figure is GENERATED, never hand-edited. It reads the same numbers the
// JSON reports carry, so a re-run of the eval updates the picture by
// regenerating it, and a chart cannot silently drift from results/.
//
// Usage:  node bin/chart.mjs docs/ollama-local-models.json [out.svg]
//
// No dependencies, no build step: this emits SVG text directly so the file
// renders in a browser, in GitHub, and in any Markdown viewer without a
// rasteriser.
//
// X-AXIS MODE. The cohort JSON declares which quantity sits on the x-axis:
//
//   "xAxis": "paramsB"   model size in billions of parameters — the local
//                        cohort's axis (a capability proxy, not a price).
//   "xAxis": "costUsd"   dollars per run, from the report's cost block — the
//                        frontier cohort's axis (what a run actually costs).
//
// The field is read, never inferred: a cohort that plots cost must say so, and
// a point missing the declared axis is refused by name rather than plotted at
// NaN. Absent "xAxis" defaults to "paramsB" so every cohort JSON written
// before this switch still renders.

import { readFileSync, writeFileSync } from "node:fs";

const W = 1180;
const H = 470;
const M = { top: 26, right: 40, bottom: 64, left: 76 };

// Colours: black ink on white, plus the per-model dots. There is no shading
// and no grid: the only structure inside the plot is the two axis lines, the
// dashed reference-solver ceiling, and the frontier staircase, so nothing
// competes with the points for attention.
const INK = "#000000";
const AXIS = "#000000";
const FRONTIER = "#171717";

const ORACLE_Y = 100;

// The two axes the chart can draw. Each supplies: the value accessor, the axis
// title, a tick generator, and a label formatter. Keeping them in one table
// means the plot body never branches on the axis name.
const AXES = {
  paramsB: {
    title: "parameters (billions)",
    value: (p) => p.paramsB,
    // Integer ticks, exactly as before this switch — the local cohort's SVG
    // must regenerate byte-for-byte, so this path is unchanged.
    ticks: (maxX) => {
      const out = [];
      for (let t = 0; t <= Math.floor(maxX); t++) out.push(t);
      return out;
    },
    format: (v) => String(v),
  },
  costUsd: {
    title: "cost per run (USD)",
    value: (p) => p.costUsd,
    // Nice-number ticks: 1/2/5 × 10^n, so a $0.0046 run and a $2.80 run both
    // land on readable gridlines instead of every cent.
    ticks: (maxX) => {
      const raw = maxX / 6;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const norm = raw / mag;
      const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
      const out = [];
      for (let t = 0; t <= maxX + step / 1000; t += step) out.push(Number(t.toFixed(10)));
      return out;
    },
    format: (v, step) => {
      // Enough decimals to distinguish adjacent ticks, no more.
      const dp = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step || 1))));
      return `$${v.toFixed(dp)}`;
    },
  },
};

/**
 * Points on the Pareto frontier: not dominated by any other point.
 *
 * A point is dominated when another is at least as good on both axes and
 * strictly better on one — cheaper at equal-or-better score, or better-scoring
 * at equal-or-lower cost. Equal cost and equal score is a tie, not domination,
 * so both survive. `xOf` is the active x-axis accessor, so the frontier is
 * computed on whichever quantity the cohort plots.
 */
export const paretoFrontier = (pts, xOf = (p) => p.paramsB) =>
  pts.filter(
    (p) =>
      !pts.some(
        (q) =>
          q !== p &&
          xOf(q) <= xOf(p) &&
          q.adjusted >= p.adjusted &&
          (xOf(q) < xOf(p) || q.adjusted > p.adjusted)
      )
  );

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const render = (data) => {
  const axis = AXES[data.xAxis ?? "paramsB"];
  const xOf = axis.value;
  const pts = [...data.points].sort((a, b) => xOf(a) - xOf(b));
  const maxX = Math.max(...pts.map(xOf)) * 1.1;
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const sx = (v) => M.left + (v / maxX) * plotW;
  const sy = (v) => M.top + plotH - (v / ORACLE_Y) * plotH;

  const frontier = new Set(paretoFrontier(pts, xOf).map((p) => p.model));
  const ticks = axis.ticks(maxX);
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`);
  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

  // Axes: thick, solid black. The only lines inside the plot besides the
  // dashed ceiling and the frontier staircase.
  out.push(`<line x1="${M.left}" y1="${sy(0)}" x2="${M.left + plotW}" y2="${sy(0)}" stroke="${AXIS}" stroke-width="2.5"/>`);
  out.push(`<line x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${sy(0)}" stroke="${AXIS}" stroke-width="2.5"/>`);

  // Tick labels, pure black.
  for (let v = 0; v <= 100; v += 20) {
    out.push(`<text x="${M.left - 14}" y="${sy(v) + 6}" text-anchor="end" font-size="16" fill="${INK}">${v}</text>`);
  }
  for (const t of ticks) {
    out.push(`<text x="${sx(t)}" y="${sy(0) + 26}" text-anchor="middle" font-size="16" fill="${INK}">${axis.format(t, step)}</text>`);
  }

  // The reference solver's ceiling, labelled in place so it needs no key.
  out.push(
    `<line x1="${M.left}" y1="${sy(ORACLE_Y)}" x2="${M.left + plotW}" y2="${sy(ORACLE_Y)}" stroke="#000000" stroke-opacity="0.45" stroke-width="1.5" stroke-dasharray="6 5"/>`
  );
  out.push(
    `<text x="${M.left + plotW}" y="${sy(ORACLE_Y) - 9}" text-anchor="end" font-size="14" fill="#000000" fill-opacity="0.6">reference solver: 100</text>`
  );

  // Frontier staircase through the non-dominated points.
  const fp = pts.filter((p) => frontier.has(p.model));
  if (fp.length > 1) {
    let d = `M ${sx(xOf(fp[0]))} ${sy(fp[0].adjusted)}`;
    for (let i = 1; i < fp.length; i++) d += ` L ${sx(xOf(fp[i]))} ${sy(fp[i - 1].adjusted)} L ${sx(xOf(fp[i]))} ${sy(fp[i].adjusted)}`;
    out.push(`<path d="${d}" fill="none" stroke="${FRONTIER}" stroke-width="1.75" stroke-dasharray="7 5" opacity="0.8"/>`);
  }

  // Points, each in its own colour, with the name alongside. The score sits
  // above the dot and the name beside it, so the plot needs no key at all.
  //
  // A start-anchored label on the rightmost point would run off the canvas at
  // these font sizes, so a label that would overflow is flipped to the other
  // side of its dot rather than clipped. The cohort's own dx/dy/anchor hints
  // still win; the flip only applies when they would put text off the edge.
  const LABEL_FS = 15.5;
  const estLabelW = (s) => String(s).length * LABEL_FS * 0.58;
  for (const p of pts) {
    const x = sx(xOf(p));
    const y = sy(p.adjusted);
    let dx = p.dx ?? 12;
    const dy = p.dy ?? 4;
    let anchor = p.anchor ?? "start";
    const label = String(p.label ?? p.model);
    const w = estLabelW(label);
    if (anchor === "start" && x + dx + w > W - 4) {
      anchor = "end";
      dx = -Math.abs(dx);
    } else if (anchor === "end" && x + dx - w < 4) {
      anchor = "start";
      dx = Math.abs(dx);
    }
    out.push(`<circle cx="${x}" cy="${y}" r="6" fill="${p.color}" stroke="#ffffff" stroke-width="1.5"/>`);
    out.push(`<text x="${x}" y="${y - 15}" text-anchor="middle" font-size="15" font-weight="600" fill="${INK}">${p.adjusted}</text>`);
    out.push(
      `<text x="${x + dx}" y="${y + dy}" text-anchor="${anchor}" font-size="${LABEL_FS}" font-weight="600" fill="${p.color}">${esc(label)}</text>`
    );
  }

  // Axis titles, pure black.
  out.push(`<text x="${M.left + plotW / 2}" y="${H - 14}" text-anchor="middle" font-size="17" fill="${INK}">${axis.title}</text>`);
  out.push(
    `<text x="22" y="${M.top + plotH / 2}" text-anchor="middle" font-size="17" fill="${INK}" transform="rotate(-90 22 ${M.top + plotH / 2})">adjusted score (0-100)</text>`
  );

  out.push("</svg>");
  return out.join("\n");
};

/**
 * Validate the cohort JSON before rendering. Without this, an empty or
 * malformed points array made Math.max() return -Infinity and every coordinate
 * NaN, and the file was still written as a "successful" render — a broken
 * chart that looked like a working one. A chart tool whose output is published
 * must fail loudly on input it cannot plot.
 *
 * The x-axis is validated on the DECLARED axis: a costUsd cohort must carry
 * costUsd on every point (and need not carry paramsB), a paramsB cohort must
 * carry paramsB, and a point missing whichever field the cohort declared is
 * named and refused.
 */
const validate = (data, input) => {
  const bad = (msg) => {
    console.error(`chart: ${msg}`);
    process.exit(1);
  };
  if (!data || !Array.isArray(data.points) || data.points.length === 0) {
    bad(`${input} has no points array; there is nothing to plot`);
  }
  const axisName = data.xAxis ?? "paramsB";
  const axis = AXES[axisName];
  if (!axis) {
    bad(`${input}: unknown xAxis ${JSON.stringify(axisName)} (known: ${Object.keys(AXES).join(", ")})`);
  }
  const xOf = axis.value;
  for (const [i, p] of data.points.entries()) {
    const name = p?.model ?? `point ${i}`;
    const xv = xOf(p);
    if (typeof xv !== "number" || !Number.isFinite(xv)) {
      bad(`${input}: ${name} has no numeric ${axisName} (got ${JSON.stringify(xv)})`);
    }
    if (typeof p?.adjusted !== "number" || !Number.isFinite(p.adjusted)) {
      bad(`${input}: ${name} has no numeric adjusted score (got ${JSON.stringify(p?.adjusted)})`);
    }
  }
  if (!data.points.some((p) => xOf(p) > 0)) {
    bad(`${input}: every ${axisName} is zero, so there is no x-axis to scale against`);
  }
};

const [, , input, outputArg] = process.argv;
if (!input) {
  console.error("usage: node bin/chart.mjs docs/ollama-local-models.json [out.svg]");
  process.exit(1);
}
const data = JSON.parse(readFileSync(input, "utf8"));
validate(data, input);
const svg = render(data);
const outPath = outputArg ?? input.replace(/\.json$/, ".svg");
writeFileSync(outPath, svg + "\n");
console.log(`wrote ${outPath} (${data.points.length} points, x-axis ${data.xAxis ?? "paramsB"})`);
