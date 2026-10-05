#!/usr/bin/env python3
"""Build the post-pivot cohort JSON from committed combined reports."""
import json, glob, os, sys
from pathlib import Path

REPO = Path("/Users/noahmclaughlin/Code/monkey-see-monkey-do")
RESULTS = REPO / "results"
COHORT = REPO / "docs" / "cohort-1-local-small-postpivot.json"

# Order by paramsB ascending (matches the original cohort sort order).
MODEL_ORDER = [
    ("gemma2:2b", 2.0, "#1f2937"),  # dark slate
    ("llama3.2:3b", 3.2, "#b91c1c"),  # red
    ("deepseek-coder:6.7b", 6.7, "#15803d"),  # green
    ("mistral:7b-instruct", 7.0, "#ca8a04"),  # amber
    ("qwen2.5-coder:7b", 7.6, "#ea580c"),  # orange
]

def find_report(model: str) -> Path:
    """Find the latest combined report for this model in results/."""
    model_slug = model.replace(":", "-")
    pattern = f"combined-ollama-{model_slug}-*.json"
    matches = sorted(RESULTS.glob(pattern))
    # Skip the old Minesweeper-era reports (their filenames start with
    # the *same* model prefix but their content is the old schema).
    # The post-pivot schema is `monkey-see-monkey-do/combined@5`; old
    # ones are `combined@4` (Minesweeper) or carry poolAWon/progressIndex.
    post_pivot = [
        m for m in matches
        if json.loads(m.read_text()).get("schema", "").startswith("monkey-see-monkey-do/combined@5")
    ]
    if not post_pivot:
        sys.exit(f"no post-pivot combined report for {model}")
    # Latest by mtime as a tie-breaker.
    return max(post_pivot, key=lambda p: p.stat().st_mtime)


# DO failure mode one-liners per model (Phase 8 Stage 2a report commits).
# Each describes the model's emitted solver in one sentence for the
# cohort table; matches the language used in the per-model commit
# messages.
FAILURE_MODES = {
    "gemma2:2b": "Emitted a solver that compares current === rule.start (number vs string, always false) and never advances state; compileError: none but no submitted step replays legally.",
    "llama3.2:3b": "Emitted a solver with INVERTED rule definitions — R1/R2/R3 patterns are the swap outputs (BA, DC, ZY) instead of the inputs (AB, CD, YZ); compiles, runs, but no submitted step matches the protocol.",
    "deepseek-coder:6.7b": "Emitted a solver with global string replace per step and a manual position counter that produces no legal derivations; every chain scores 0 submitted steps.",
    "mistral:7b-instruct": "Emitted a solver that pretends to apply them — uses each character of the input as a rule name (current[i]) and returns garbage 3-tuples; every chain scores 0 submitted steps.",
    "qwen2.5-coder:7b": "Emitted a solver with global string replace per step and no upper bound on the while loop; every chain hits the 10000ms sandbox cap before the solver can finish, partial-credit hits are steps the sandbox emitted before the kill.",
}

# Label placement for the chart. With most adjusted values near 0
# (and qwen slightly above 0 once the engagement clawback is folded in),
# the dots cluster and labels must not collide.
LABEL_PLACEMENT = {
    "gemma2:2b":            {"dx": -16, "dy": -8, "anchor": "end"},
    "llama3.2:3b":          {"dx": 16, "dy": -8, "anchor": "start"},
    "deepseek-coder:6.7b":  {"dx": 16, "dy": 4, "anchor": "start"},
    "mistral:7b-instruct":  {"dx": -16, "dy": 4, "anchor": "end"},
    "qwen2.5-coder:7b":     {"dx": 16, "dy": -8, "anchor": "start"},
}


def summarize(model: str, params_b: float, color: str) -> dict:
    path = find_report(model)
    r = json.loads(path.read_text())
    adj = r.get("adjusted", {})
    do = r.get("do", {})
    see = r.get("see", {})
    stability = r.get("stability") or {}
    placement = LABEL_PLACEMENT.get(model, {"dx": 12, "dy": 4, "anchor": "start"})
    return {
        "model": model,
        "label": model,
        "paramsB": params_b,
        "see": see.get("total"),
        "seeMax": see.get("max"),
        "do": do.get("total"),
        "doMax": do.get("max"),
        "chainEngagementRate": do.get("chainEngagementRate"),
        "gzMean": round(adj.get("components", {}).get("gzMean", 0), 2),
        "base": adj.get("base"),
        "gzMeanPenalty": adj.get("gzMeanPenalty"),
        "unearnedPenalty": adj.get("unearnedPenalty"),
        "adjusted": adj.get("total"),
        "stability": {
            "runs": stability.get("runs"),
            "seeSpread": stability.get("seeSpread"),
            "doSpread": stability.get("doSpread"),
            "seeVerdict": stability.get("seeVerdict"),
            "doVerdict": stability.get("doVerdict"),
            "seeTotals": stability.get("seeTotals"),
            "doTotals": stability.get("doTotals"),
        },
        "cost": {
            "see": r.get("cost", {}).get("see", {}).get("usage"),
            "do": r.get("cost", {}).get("do", {}).get("usage"),
            "seePricing": r.get("cost", {}).get("see", {}).get("pricing"),
            "doPricing": r.get("cost", {}).get("do", {}).get("pricing"),
        },
        "callFailure": r.get("callFailure"),
        "color": color,
        "dx": placement["dx"],
        "dy": placement["dy"],
        "anchor": placement["anchor"],
        "source": f"results/{path.name}",
        "doFailureMode": FAILURE_MODES.get(model, ""),
    }


def main():
    points = [summarize(*m) for m in MODEL_ORDER]
    # Sort by adjusted descending, then by paramsB descending as a tie-
    # breaker so the table reads left-to-right at adjusted=0 (largest
    # model first within a tie).
    points.sort(key=lambda p: (-p["adjusted"], -p["paramsB"]))

    out = {
        "cohort": "Cohort 1 (post-pivot) — small local models (<8B, Ollama on Apple M2)",
        "suiteVersion": "1.0.0",
        "date": "2026-10-05",
        "xAxis": "paramsB",
        "yAxis": "adjusted",
        "runs": 3,
        "temperature": 0,
        "methodology": "Each model scored -r 3 at temperature 0 with the corrected CALL_TIMEOUT_MS=10000 (Phase 8 Stage 1.5). Medians of the 3 headline totals are the published values.",
        "points": points,
        "evidence": "Every point traces to its three-run combined report (median headline, per-run totals in stability).",
    }
    COHORT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {COHORT.relative_to(REPO)}")
    for p in points:
        print(f"  {p['model']:30s} see={p['see']:>3}/{p['seeMax']} do={p['do']:>5}/{p['doMax']} adj={p['adjusted']:>3} gzMean={p['gzMean']:>5} engagement={p['chainEngagementRate']}")


if __name__ == "__main__":
    main()