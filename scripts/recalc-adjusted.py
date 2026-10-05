#!/usr/bin/env python3
"""Recalculate the 1.1.0 adjusted reading for every post-pivot combined
report under results/. Writes the new reading as
`adjusted.total_1_1_0` (with formula stamp) BESIDE the original
`adjusted.total`. Never overwrites the original. Pure function of
the four components already on every report (see total, do total,
gzMean, chainEngagementRate), so no model re-runs.

Usage:
  python3 scripts/recalc-adjusted.py                  # all reports
  python3 scripts/recalc-adjusted.py path/to/file.json # one report
"""
import sys, glob, os
from pathlib import Path

REPO = Path("/Users/noahmclaughlin/Code/monkey-see-monkey-do")
RESULTS = REPO / "results"


def recalc_one(path: Path) -> dict:
    """Return the 1.1.0 reading for the report at `path`."""
    import json
    r = json.loads(path.read_text())
    schema = r.get("schema", "")
    # Only post-pivot combined reports carry the components we need.
    if not schema.startswith("monkey-see-monkey-do/combined@"):
        return None
    see = r.get("see", {})
    do = r.get("do", {})
    adj = r.get("adjusted", {})
    # The four components the 1.1.0 formula lives on.
    seeTotal = see.get("total")
    doTotal = do.get("total")
    gzMean = adj.get("components", {}).get("gzMean")
    eng = do.get("chainEngagementRate")
    if None in (seeTotal, doTotal, gzMean, eng):
        return None
    # 1.1.0: scale GZ penalty by earned fraction, keep engagement
    # clawback fixed. Mirrors src/adjusted.mjs adjustedTotal().
    base = seeTotal + doTotal
    safeGz = max(0, gzMean)
    earned = max(0, min(1, base / 100))
    gzPenalty = safeGz * 0.5 * earned
    claw = max(0, min(1, eng))
    clawPenalty = max(0, 10 * (1 - claw))
    raw = base - gzPenalty - clawPenalty
    total = max(0, min(100, round(raw)))
    # NOTE: the top-level `adjusted.gzMeanPenalty` on the report is the
    # ORIGINAL 1.0.0 reading — we do not overwrite it. The 1.1.0 value
    # lives entirely under `adjusted.total_1_1_0_components` so the
    # audit trail is intact and a chart can plot either reading.
    return {
        "total": total,
        "max": 100,
        "base": base,
        "gzMeanPenalty": round(gzPenalty, 2),
        "unearnedPenalty": round(clawPenalty, 2),
        "earnedFraction": round(earned, 4),
        "formula": "clamp(see + do - 0.5*GZ_mean*(see+do)/100 - 10*(1 - chainEngagementRate), 0, 100)",
        "formulaVersion": "1.1.0",
    }


def stamp(path: Path, recalc: dict) -> bool:
    """Write recalc to the report as adjusted.total_1_1_0 (no-op if
    already stamped). Returns True if the file was changed."""
    import json
    text = path.read_text()
    r = json.loads(text)
    if r.get("adjusted", {}).get("total_1_1_0"):
        return False  # already stamped
    # Preserve original; add the new reading alongside.
    if "total_1_1_0" in (r.get("adjusted") or {}):
        # Was an entry without 'total' — skip rather than clobber.
        return False
    r.setdefault("adjusted", {})["total_1_1_0"] = recalc["total"]
    r["adjusted"]["total_1_1_0_components"] = recalc
    r["adjusted"]["formulaVersion_1_1_0"] = recalc["formulaVersion"]
    # Stamp the original 1.0.0 reading too, so both are explicit.
    if r["adjusted"].get("components", {}).get("formulaVersion") != "1.0.0":
        r["adjusted"].setdefault("components", {})["formulaVersion"] = "1.0.0"
    path.write_text(json.dumps(r, indent=2) + "\n")
    return True


def main(argv):
    if len(argv) > 1:
        targets = [Path(a) for a in argv[1:]]
    else:
        targets = sorted(RESULTS.glob("combined-ollama-*.json"))
    n_changed = 0
    n_skipped = 0
    for path in targets:
        # Skip Minesweeper-era (combined@4) reports — only post-pivot
        # combined@5 reports have the four components the recalc needs.
        import json
        r = json.loads(path.read_text())
        if not r.get("schema", "").startswith("monkey-see-monkey-do/combined@5"):
            n_skipped += 1
            continue
        recalc = recalc_one(path)
        if recalc is None:
            n_skipped += 1
            continue
        if stamp(path, recalc):
            n_changed += 1
            print(f"  {path.relative_to(REPO)}: 1.0.0={r['adjusted']['total']} → 1.1.0={recalc['total']}")
        else:
            n_skipped += 1
    print(f"\nStamped {n_changed} reports; skipped {n_skipped}.")


if __name__ == "__main__":
    main(sys.argv)