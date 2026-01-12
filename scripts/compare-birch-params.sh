#!/bin/bash
# Compare BIRCH clustering with different threshold, dimension, and branching values
# Grid search to find sweet spots for auto-clustering

echo "=== BIRCH Parameter Grid Search ==="
echo ""
echo "| Dims | Threshold | Branching | Subclusters |"
echo "|------|-----------|-----------|-------------|"

# Grid search across dimensions, thresholds, and branching factors
for dims in 16 32 64 128; do
  for threshold in 0.08 0.1 0.12 0.15 0.2 0.25 0.3; do
    for branching in 10 30 50; do
      subclusters=$(pnpm explore-likes:birch --dimensions $dims --threshold $threshold --branching $branching 2>&1 | \
        grep -E "CF tree created" | \
        sed 's/.*CF tree created //' | \
        sed 's/ subclusters//')
      echo "| $dims | $threshold | $branching | $subclusters |"
    done
  done
done

echo ""
echo "Done!"
