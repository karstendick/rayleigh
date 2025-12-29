#!/bin/bash
# Run explore-likes with different parameter combinations
# Each run generates a separate report in output/

set -e

DIMENSIONS=(256 512 1536)
MIN_CLUSTERS=(3 5)
MIN_SAMPLES=(1 3)

total=$((${#DIMENSIONS[@]} * ${#MIN_CLUSTERS[@]} * ${#MIN_SAMPLES[@]}))
count=0

echo "Running $total experiments..."
echo ""

for dim in "${DIMENSIONS[@]}"; do
  for min_cluster in "${MIN_CLUSTERS[@]}"; do
    for min_samples in "${MIN_SAMPLES[@]}"; do
      count=$((count + 1))
      echo "=== Experiment $count/$total: dim=$dim min-cluster=$min_cluster min-samples=$min_samples ==="
      pnpm explore-likes --dimensions "$dim" --min-cluster "$min_cluster" --min-samples "$min_samples"
      echo ""
    done
  done
done

echo "All experiments complete! Results in output/"
