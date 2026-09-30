#!/bin/bash
# Compare several models in one go.
#
#   bash compare.sh
#
# Each model is run 3 times so we can tell a real score from noise. Both models
# below are free, and both are pinned to their single provider with fallback
# disabled — a fallback would be a different machine, and a different answer.

cd "$(dirname "$0")" || exit 1

MODELS=(
  "nvidia/nemotron-3-ultra-550b-a55b:free|Nvidia"
  "thinkingmachines/inkling:free|Thinking Machines"
  "dots-studio/dots-3-note-preview:free|AtlasCloud"
)

for entry in "${MODELS[@]}"; do
  model="${entry%%|*}"
  provider="${entry##*|}"

  echo ""
  echo "=============================================================="
  echo "  $model"
  echo "=============================================================="

  node src/see/run.mjs \
    -m "openrouter/$model" \
    -r 3 \
    -s 42 \
    --only-provider "$provider" \
    --no-fallback
done

echo ""
echo "Done. Look for REPRODUCIBLE vs NOT REPRODUCIBLE under each model."
echo "A NOT REPRODUCIBLE score cannot be compared to anything, including itself."
