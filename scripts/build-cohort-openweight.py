#!/usr/bin/env python3
"""Build Cohort 1 (open-weight frontier models, OpenRouter) from combined reports.

Sibling of scripts/build-cohort.py, which builds Cohort 2 (the local Ollama
models). This one cannot reuse that script: the model ids, the report glob, the
x-axis and the per-point cost all differ.

The x-axis is costUsd, not paramsB: the frontier question is "what does a run
cost", not "how big is the model", so every point carries the run's dollars
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
# omitted (the provider default applied); it is NOT the level "none".
COHORT = [
    {
        "model": "openrouter/qwen/qwen3.8-27b",
        "label": "Qwen 3.8 27B",
        "provider": "Alibaba",
        "color": "#7c3aed",
        "effort": "medium",
        "efforts": ["xhigh", "medium", "low"],
    },
    {
        "model": "openrouter/deepseek/deepseek-v4.1-flash",
        "label": "DeepSeek V4.1 Flash",
        # DeepInfra, NOT DeepSeek: the first-party DeepSeek endpoint is excluded
        # by this account's OpenRouter privacy setting and returns HTTP 404
        # "0 endpoints out of 1 requested" on a pinned request, so the run
        # pinned DeepInfra instead. The rate row and the run's own
        # generation.providerPin both say DeepInfra; this spec must agree with
        # them, or the published chart names a host that served nothing.
        "provider": "DeepInfra",
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
    "openrouter/qwen/qwen3.8-27b":             {"dx": 14, "dy": -8, "anchor": "start"},
    "openrouter/deepseek/deepseek-v4.1-flash": {"dx": 14, "dy": -8, "anchor": "start"},
    "openrouter/z-ai/glm-5.3":                 {"dx": -14, "dy": -8, "anchor": "end"},
    "openrouter/xiaomi/mimo-v2.6-pro":         {"dx": 14, "dy": 4, "anchor": "start"},
    "openrouter/tencent/hy3":                  {"dx": 14, "dy": 4, "anchor": "start"},
}


def report_slug(model: str) -> str:
    """Mirror src/report.mjs slug(): non [a-zA-Z0-9._-] runs become '-'.

    'openrouter/qwen/qwen3.8-27b' -> 'openrouter-qwen-qwen3.8-27b',
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
    """Measured run cost = priced SEE + priced DO, or None when NEITHER half is
    priced.

    A timed-out call returns no usage, so its half is unpriced while the other
    half is known. Returning None for the whole run would discard a real
    number; summing a known half with a guessed one would invent one. So the
    priced halves are summed and `costComplete` records whether both were
    priced, so a caller must not treat a partial total as the full run cost.
    """
    c = r.get("cost") or {}
    see, do = c.get("see") or {}, c.get("do") or {}
    sv, dv = see.get("costUsd"), do.get("costUsd")
    if sv is None and dv is None:
        return None
    return round((sv or 0) + (dv or 0), 6)


def cost_flags(r: dict):
    """Which half of the run's cost is measured, and which is missing."""
    c = r.get("cost") or {}
    see, do = c.get("see") or {}, c.get("do") or {}
    missing = [name for name, blk in (("see", see), ("do", do)) if blk.get("costUsd") is None]
    return {"costComplete": not missing, "costMissing": missing}


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
            f"{model}: its report carries no priced cost at all (both "
            f"cost.see.costUsd and cost.do.costUsd are null), so the costUsd "
            f"axis has no value for it.\n"
            f"  report: results/{path.name}\n"
            f"  check the OpenRouter rate row for this model in "
            f"config/openrouter-rates.json."
        )
    # A route-failed DO call scores 0/50 but says nothing about the model. The
    # published cohort must carry that distinction, or the zero reads as a
    # result (AGENTS.md: never present a failed-call zero as a model score).
    doFailed = (r.get("callFailure") or {}).get("do") is not None
    return {
        "model": model,
        "label": spec["label"],
        "provider": spec["provider"],
        "costUsd": usd,
        **cost_flags(r),
        "reasoningEffort": spec["effort"],
        "reasoningEfforts": spec["efforts"],
        "see": see.get("total"),
        "seeMax": see.get("max"),
        "do": do.get("total"),
        "doMax": do.get("max"),
        # Suite 1.2.0 headline is chains SOLVED; the 1.1.0 step-legality ratio
        # rides alongside so a reader can see why the number moved. DO is not
        # comparable across the 1.1 -> 1.2 boundary.
        "do_1_1_0": do.get("total_1_1_0"),
        "stepLegalityRatio": do.get("stepLegalityRatio"),
        "doFullCreditChains": do.get("fullCreditChains"),
        # True when the DO call never returned: `do` is a route-failure zero,
        # not a model score, and `adjusted` is derived from that zero. The
        # published table prints "DO: no result" for these, never "0/50", so a
        # reader cannot mistake a dead call for a model that scored nothing.
        "doRouteFailed": doFailed,
        "doDisplay": "no result" if doFailed else f"{do.get('total')}/50",
        "doNote": (
            "no solver emitted within budget; the model reasoned indefinitely "
            "and produced zero content at every cap tested"
            if doFailed else None
        ),
        "doFailureReason": ((r.get("callFailure") or {}).get("do") or {}).get("reason") if doFailed else None,
        "doFullCreditChains": sum(
            (b.get("fullCreditChains") or 0) for b in (do.get("perBand") or {}).values()
        ) if not doFailed else None,
        "chainEngagementRate": do.get("chainEngagementRate"),
        "gzMean": round((adj.get("components") or {}).get("gzMean", 0), 2),
        "base": adj.get("base"),
        "gzMeanPenalty": adj.get("gzMeanPenalty"),
        "unearnedPenalty": adj.get("unearnedPenalty"),
        "adjusted": adj.get("total_1_1_0", adj.get("total")),
        "adjusted_1_1_0": adj.get("total_1_1_0"),
        "adjusted_1_0_0": adj.get("total"),
        # An adjusted figure built on a route-failed DO is not a model reading.
        "adjustedComparable": not doFailed,
        # The per-run DO totals, so a model whose published DO is one sample
        # from a range shows the range beside it (qwen: [0, 50, 50]).
        "doRunSpread": {
            "totals_1_1_0": stability.get("doTotals"),
            "doCallFailures": stability.get("doCallFailures"),
            "answeredDoRuns": stability.get("answeredDoRuns"),
        },
        "stability": {
            "runs": stability.get("runs"),
            "seeSpread": stability.get("seeSpread"),
            "doSpread": stability.get("doSpread"),
            "seeVerdict": stability.get("seeVerdict"),
            "doVerdict": stability.get("doVerdict"),
            "answeredDoRuns": stability.get("answeredDoRuns"),
            "seeTotals": stability.get("seeTotals"),
            "doTotals": stability.get("doTotals"),
            "doCallFailures": stability.get("doCallFailures"),
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
    # Cheapest measured run first: the cost axis reads left to right as spend.
    points.sort(key=lambda p: p["costUsd"])

    doFailed = [p["label"] for p in points if p["doRouteFailed"]]
    doMeasured = [p["label"] for p in points if not p["doRouteFailed"]]

    out = {
        "cohort": "Cohort 1: open-weight frontier models (OpenRouter)",
        "suiteVersion": "1.1.0",
        "date": "2026-10-05",
        "xAxis": "costUsd",
        "yAxis": "adjusted",
        "runs": 3,
        "temperature": 0,
        "suiteVersion": "1.2.0",
        "methodology": (
            "Each model scored -r 3 at pinned temperature 0 with "
            "--only-provider <its host> --no-fallback (every model here is "
            "multi-endpoint on OpenRouter, so an unpinned run would mix "
            "quantizations). Cost is dollars per run under the pinned host, at the "
            "pinned-endpoint rates in config/openrouter-rates.json (NOT the "
            "model-level list rate); where a DO call never returned, its half of "
            "the cost is unmeasured and `costComplete` is false. A per-model "
            "reasoning-effort rung is recorded beside each score: effort is a "
            "confound on the order of temperature, the ladders differ per model, "
            "and an unset effort means the parameter was omitted and the provider "
            "default applied."
        ),
        # The DO half of this cohort is largely a harness measurement, not a
        # model measurement. Stated at the top level so no reader has to infer
        # it from per-point flags.
        "doMeasurementCaveat": (
            f"{len(doFailed)} of {len(points)} models had their DO call time out at "
            f"the 420000ms HTTP budget on every run ({', '.join(doFailed) or 'none'}), "
            f"so their `do` value is a route-failure zero and their `adjusted` is "
            f"derived from it. Only {', '.join(doMeasured) or 'none'} produced a DO "
            f"score. The published table prints \"DO: no result\" for these, never "
            f"a number. A failed-call zero is not a model score (AGENTS.md); see "
            f"`doRouteFailed` and `adjustedComparable` on each point."
        ),
        "points": points,
        "evidence": "Every point traces to its three-run combined report; the per-run totals and route failures live in stability.",
    }
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(REPO)}")
    for p in points:
        flags = ""
        if p["doRouteFailed"]:
            flags = f"  [DO ROUTE-FAILED: {p['doFailureReason']}; adjusted not comparable]"
        elif not p["costComplete"]:
            flags = f"  [cost partial: missing {','.join(p['costMissing'])}]"
        print(
            f"  {p['label']:22s} cost=${p['costUsd']:<9} see={p['see']:>3}/{p['seeMax']} "
            f"do={p['do']:>5}/{p['doMax']} adj={p['adjusted']:>3} "
            f"effort={p['reasoningEffort']}{flags}"
        )
    print(f"\n  DO measured on {len(doMeasured)}/{len(points)} models; "
          f"route-failed on {len(doFailed)}.")


if __name__ == "__main__":
    main()
