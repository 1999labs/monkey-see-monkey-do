#!/usr/bin/env python3
"""Re-derive the suite-1.2.0 DO readings across every committed report.

Suite 1.2.0 changed the DO headline from the step-legality ratio to the
fullCredit fraction (chains solved). No model is re-run: both readings are pure
functions of data the reports already carry (perBand.fullCreditChains /
chainCount for the headline; perBand.points for the old reading).

This script:
  - writes do.total_1_1_0 (the old reading) and do.total (the new one)
  - writes do.stepLegalityRatio and do.fullCreditChains
  - recomputes chainEngagementRate as the fullCredit fraction (1.2.0 definition)
  - recomputes the combined `reading` string on the corrected format
  - preserves the pre-1.2.0 values under do.suite_1_1_0 / combined.reading_revision

Reports whose DO call never returned have no perBand at all: they keep a null
headline and are marked doRouteFailed, because a route failure is not a score.
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RESULTS = REPO / "results"

BANDS = ["L5", "L10", "L20", "L30", "L50"]
BAND_WEIGHT = 10  # each band is worth 10 points


def headline(per_band):
    """Suite 1.2.0: sum over bands of (fullCreditChains / chainCount) * 10."""
    total = 0.0
    for name in BANDS:
        b = per_band.get(name)
        if not b:
            continue
        cc = b.get("chainCount") or 0
        fc = b.get("fullCreditChains") or 0
        if cc:
            total += (fc / cc) * BAND_WEIGHT
    return round(total, 2)


def legality(per_band):
    """Suite 1.1.0: sum of the band points (mean chainScore * band weight)."""
    return round(sum((b.get("points") or 0) for b in per_band.values()), 2)


def reading_lines(see, do_block, full_credit, chain_count):
    """The corrected `reading` string (matches src/run-all.mjs summarise)."""
    pt = lambda k: see["perTask"][k]["weightedRate"]
    task_points = pt("A") * 15 + pt("B") * 15 + pt("C") * 15
    robustness = round(see["total"] - task_points, 4)
    per_level = see["perLevel"]
    # A run whose every SEE call failed has null gz at every level; render those
    # as "n/a" rather than crashing, and keep the GZ_mean honest.
    def gz_pct(v):
        return "n/a" if v is None else f"{v * 100:.1f}%"

    gz = "  ".join(
        f"L{l}={gz_pct(per_level[l].get('gz'))}" for l in sorted(per_level, key=int)
    )
    gz_vals = [per_level[l]["gz"] for l in per_level if per_level[l].get("gz") is not None]
    gz_mean = (sum(gz_vals) / len(gz_vals) * 100) if gz_vals else 0.0
    do_total = do_block["total"]
    n = chain_count or 50
    return [
        f"  MONKEY SEE         {see['total']:.2f}/50   weighted: A={pt('A') * 100:.1f}%  B={pt('B') * 100:.1f}%  C={pt('C') * 100:.1f}%",
        f"    task points {task_points:.2f}/45 + robustness {robustness:.2f}/5",
        f"    GZ (per level): {gz}  GZ_mean={gz_mean:.2f}%",
        f"  MONKEY DO          {do_total}/50   {full_credit}/{n} chains full credit, 0 partial",
        f"  SEE {see['total']:.0f}/50 + DO {do_total}/50 = combined {(see['total'] + do_total):.0f}/100",
    ]


def main():
    files = sorted(RESULTS.glob("combined-*.json"))
    if not files:
        sys.exit("no combined reports found")
    changed = 0
    for f in files:
        r = json.loads(f.read_text())
        do = r.get("do") or {}
        see = r.get("see") or {}
        per_band = do.get("perBand") or {}

        # Preserve the pre-1.2.0 block once, so the audit trail is stable even
        # if this script is re-run.
        if "suite_1_1_0" not in do:
            do["suite_1_1_0"] = {
                "total": do.get("total"),
                "chainEngagementRate": do.get("chainEngagementRate"),
                "note": "pre-1.2.0: total was the step-legality ratio; engagement was 'made at least one legal step'.",
            }

        route_failed = (r.get("callFailure") or {}).get("do") is not None

        if per_band:
            new_total = headline(per_band)
            old_total = legality(per_band)
            fc = sum((b.get("fullCreditChains") or 0) for b in per_band.values())
            cc = sum((b.get("chainCount") or 0) for b in per_band.values())
            do["total"] = new_total
            do["total_1_1_0"] = old_total
            do["stepLegalityRatio"] = old_total / 50 if old_total else 0
            do["fullCreditChains"] = fc
            do["chainEngagementRate"] = round(fc / cc, 4) if cc else 0
            do["doRouteFailed"] = False
        else:
            do["total_1_1_0"] = None
            do["stepLegalityRatio"] = None
            do["fullCreditChains"] = None
            do["doRouteFailed"] = route_failed
            # total stays whatever the report says (0 for a route failure)

        # Combined block: median-aware total + the corrected reading.
        comb = r.setdefault("combined", {})
        if per_band:
            do_median = do["total"]
            see_total = see.get("total") or 0
            comb["total"] = see_total + do_median

        # The adjusted total is unchanged in FORMULA (1.2.0 moved only the DO
        # score definition and the engagement input), but its inputs changed for
        # two models, so it must be recomputed from the new components. The
        # 1.1.0 reading is preserved untouched.
        adj = r.setdefault("adjusted", {})
        comps = adj.get("components") or {}
        gz_mean = comps.get("gzMean")
        see_total = see.get("total")
        if see_total is not None and gz_mean is not None:
            base = see_total + (do.get("total") or 0)
            eng = do.get("chainEngagementRate") or 0
            safe_gz = max(0, gz_mean)
            earned = max(0, min(1, base / 100))
            gz_penalty = safe_gz * 0.5 * earned
            claw = max(0, min(1, eng))
            claw_penalty = 10 * (1 - claw)
            total = max(0, min(100, round(base - gz_penalty - claw_penalty)))
            if "total_1_1_0" not in adj:
                adj["total_1_1_0"] = adj.get("total")
            adj["total_1_2_0"] = total
            adj["total_1_2_0_components"] = {
                "base": base,
                "gzMeanPenalty": round(gz_penalty, 2),
                "unearnedPenalty": round(claw_penalty, 2),
                "earnedFraction": round(earned, 4),
                "chainEngagementRate": eng,
                "formula": "clamp(see + do - 0.5*GZ_mean*(see+do)/100 - 10*(1 - chainEngagementRate), 0, 100)",
                "formulaVersion": "1.2.0",
                "note": "formula unchanged from 1.1.0; the DO score and the engagement input are 1.2.0 definitions.",
            }
            # The headline figure the charts read.
            adj["total"] = total

        before = comb.get("reading")
        if see.get("perTask") and see.get("perLevel"):
            new_reading = reading_lines(
                see, do, do.get("fullCreditChains") or 0,
                sum((b.get("chainCount") or 0) for b in per_band.values()) or 50,
            )
            comb["reading"] = new_reading
        if before and "reading_revision" not in comb:
            comb["reading_revision"] = {
                "revised": "2026-10-05",
                "reason": "The reading understated SEE by omitting the robustness points (it summed only the 45 task points) and printed a combined denominator of 95 while combined.max is 100. SEE is out of 50 (45 task + 5 robustness); the combined total is out of 100. The stale '(v2)' label was also dropped.",
                "before": before,
            }
        elif before and "reading_revision" in comb:
            comb["reading_revision"]["before"] = before

        f.write_text(json.dumps(r, indent=2) + "\n")
        changed += 1
        flag = "ROUTE-FAILED" if do.get("doRouteFailed") else f"do={do.get('total')} (was {do.get('total_1_1_0')})"
        print(f"  {f.name[:62]:<62} {flag}")
    print(f"\nre-derived {changed} reports")


if __name__ == "__main__":
    main()
