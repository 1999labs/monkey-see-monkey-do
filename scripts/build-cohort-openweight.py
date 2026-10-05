#!/usr/bin/env python3
"""Build Cohort 1 (open-weight frontier models, OpenRouter) from combined reports.

Sibling of scripts/build-cohort.py, which builds Cohort 2 (the local Ollama
models). This one cannot reuse that script: the model ids, the report glob, the
x-axis and the per-point cost all differ.

The x-axis is costUsd, not paramsB — the frontier question is "what does a run
cost", not "how big is the model" — so every point carries the run's dollars
from its report's cost block. The chart already supports the costUsd axis
(bin/chart.mjs, xAxis mode).

There are no reports yet, by design: the sweep has not run. Absent reports are a
loud, named failure, not an empty chart, so completing the sweep is what
produces this file.
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RESULTS = REPO / "results"
OUT = REPO / "docs" / "openweight-frontier-models.json"

# The cohort, in table order. `effort` is the rung pinned for the run and
# `efforts` is the ladder the model lists; both are copied from
# config/phase9-cohort.json and config/reasoning-efforts.json so the emitted
# cohort is auditable on its own. `effort: None` means the parameter was
# omitted (the provider default applied) — it is NOT the level "none".
COHORT = [
    {
        "model": "openrouter/qwen/qwen3.8-2.4t-a95b",
        "label": "Qwen 3.8 2.4T A95B",
        "provider": "Alibaba",
        "color": "#7c3aed",
        "effort": "medium",
        "efforts": ["xhigh", "medium", "low"],
    },
    {
        "model": "openrouter/deepseek/deepseek-v4.1-flash",
        "label": "DeepSeek V4.1 Flash",
        "provider": "DeepSeek",
        "color": "#0e7490",
        "effort": "high",
        "efforts": ["max", "high", "low"],
    },
    {
        "model": "openrouter/z-ai/glm-5.3",
        "label": "GLM 5.3",
        "provider": "Z.AI",
        "color": "#b45309",
        "effort": "high",
        "efforts": ["max", "high", "low"],
    },
    {
        "model": "openrouter/xiaomi/mimo-v2.6-pro",
        "label": "MiMo V2.6 Pro",
        "provider": "Xiaomi",
        "color": "#15803d",
        "effort": None,
        "efforts": [],
    },
    {
        "model": "openrouter/tencent/hy3",
        "label": "Hy3",
        "provider": "Tencent",
        "color": "#be123c",
        "effort": "high",
        "efforts": ["high", "low", "none"],
    },
]

# Label placement so the dots do not collide on a log-ish cost axis.
LABEL_PLACEMENT = {
    "openrouter/qwen/qwen3.8-2.4t-a95b":       {"dx": 14, "dy": -8, "anchor": "start"},
    "openrouter/deepseek/deepseek-v4.1-flash": {"dx": 14, "dy": -8, "anchor": "start"},
    "openrouter/z-ai/glm-5.3":                 {"dx": -14, "dy": -8, "anchor": "end"},
    "openrouter/xiaomi/mimo-v2.6-pro":         {"dx": 14, "dy": 4, "anchor": "start"},
    "openrouter/tencent/hy3":                  {"dx": 14, "dy": 4, "anchor": "start"},
}


def report_slug(model: str) -> str:
    """Mirror src/report.mjs slug(): non [a-zA-Z0-9._-] runs become '-'.

    'openrouter/qwen/qwen3.8-2.4t-a95b' -> 'openrouter-qwen-qwen3.8-2.4t-a95b',
    which is what the runner puts in the combined report's filename.
    """
    import re
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", model).strip("-")[:80]


def find_report(spec: dict) -> Path:
    """The latest combined@5 report for this model, or a loud exit."""
    model = spec["model"]
    pattern = f"combined-{report_slug(model)}-*.json"
    matches = sorted(RESULTS.glob(pattern))
    post_pivot = [
        m for m in matches
        if json.loads(m.read_text()).get("schema", "").startswith("monkey-see-monkey-do/combined@5")
    ]
    if not post_pivot:
        found = sorted(RESULTS.glob("combined-*.json"))
        hint = "\n".join(f"    {p.name}" for p in found[-8:]) or "    (none)"
        sys.exit(
            f"no combined@5 report for {model}\n"
            f"  looked for: results/{pattern}\n"
            f"  run the sweep first:  npm run all -- -m {model} -r 3 "
            f"--only-provider {spec.get('provider', '<host>')} --no-fallback "
            f"--config config/phase9-cohort.json\n"
            f"  recent combined reports on disk:\n{hint}"
        )
    return max(post_pivot, key=lambda p: p.stat().st_mtime)


def cost_usd(r: dict):
    """Total run cost = SEE + DO, or None if either half is unpriced.

    The report's cost block carries a costUsd per eval; a null in either half
    means that half was not priced, so the total is unknown rather than
    partial. Summing a known half with an unknown one would understate the
    run and put a misleading point on the cost axis.
    """
    c = r.get("cost") or {}
    see, do = c.get("see") or {}, c.get("do") or {}
    if see.get("costUsd") is None or do.get("costUsd") is None:
        return None
    return round(see["costUsd"] + do["costUsd"], 6)


def summarize(spec: dict) -> dict:
    model = spec["model"]
    path = find_report(spec)
    r = json.loads(path.read_text())
    adj = r.get("adjusted") or {}
    do = r.get("do") or {}
    see = r.get("see") or {}
    stability = r.get("stability") or {}
    placement = LABEL_PLACEMENT.get(model, {"dx": 12, "dy": 4, "anchor": "start"})
    usd = cost_usd(r)
    if usd is None:
        sys.exit(
            f"{model}: its report carries no priced cost (cost.see.costUsd or "
            f"cost.do.costUsd is null), so the costUsd axis has no value for it.\n"
            f"  report: results/{path.name}\n"
            f"  a Cohort 1 point needs dollars; check the OpenRouter rate row for "
            f"this model in config/openrouter-rates.json."
        )
    return {
        "model": model,
        "label": spec["label"],
        "provider": spec["provider"],
        "costUsd": usd,
        "reasoningEffort": spec["effort"],
        "reasoningEfforts": spec["efforts"],
        "see": see.get("total"),
        "seeMax": see.get("max"),
        "do": do.get("total"),
        "doMax": do.get("max"),
        "chainEngagementRate": do.get("chainEngagementRate"),
        "gzMean": round((adj.get("components") or {}).get("gzMean", 0), 2),
        "base": adj.get("base"),
        "gzMeanPenalty": adj.get("gzMeanPenalty"),
        "unearnedPenalty": adj.get("unearnedPenalty"),
        "adjusted": adj.get("total_1_1_0", adj.get("total")),
        "adjusted_1_1_0": adj.get("total_1_1_0"),
        "adjusted_1_0_0": adj.get("total"),
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
            "see": (r.get("cost") or {}).get("see"),
            "do": (r.get("cost") or {}).get("do"),
        },
        "callFailure": r.get("callFailure"),
        "temperature": r.get("temperature"),
        "color": spec["color"],
        "dx": placement["dx"],
        "dy": placement["dy"],
        "anchor": placement["anchor"],
        "source": f"results/{path.name}",
    }


def main() -> None:
    points = [summarize(spec) for spec in COHORT]
    # Cheapest run first: the cost axis reads left to right as spend.
    points.sort(key=lambda p: p["costUsd"])

    out = {
        "cohort": "Cohort 1 — open-weight frontier models (OpenRouter)",
        "suiteVersion": "1.1.0",
        "date": "2026-10-05",
        "xAxis": "costUsd",
        "yAxis": "adjusted",
        "runs": 3,
        "temperature": 0,
        "methodology": (
            "Each model scored -r 3 at pinned temperature 0 with "
            "--only-provider <its host> --no-fallback (every model here is "
            "multi-endpoint on OpenRouter, so an unpinned run would mix "
            "quantizations). Cost is dollars per run under the pinned host, at the "
            "pinned-endpoint rates in config/openrouter-rates.json (NOT the "
            "model-level list rate). The x-axis is "
            "dollars per run, summed from the report's cost block at the rates in "
            "config/openrouter-rates.json (as of its _asOf date). A per-model "
            "reasoning-effort rung is recorded beside each score: effort is a "
            "confound on the order of temperature, the ladders differ per model, and "
            "an unset effort means the parameter was omitted and the provider "
            "default applied."
        ),
        "points": points,
        "evidence": "Every point traces to its three-run combined report; the per-run totals live in stability.",
    }
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(REPO)}")
    for p in points:
        print(
            f"  {p['label']:22s} cost=${p['costUsd']:<9} see={p['see']:>3}/{p['seeMax']} "
            f"do={p['do']:>5}/{p['doMax']} adj={p['adjusted']:>3} effort={p['reasoningEffort']}"
        )


if __name__ == "__main__":
    main()
