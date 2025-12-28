/**
 * Test script for hdbscan-ts with high-dimensional embeddings
 *
 * Tests:
 * 1. Basic functionality with low-dim data
 * 2. Performance with 1536-dim embeddings (OpenAI size)
 * 3. Scaling with different dataset sizes
 */

import { HDBSCAN } from 'hdbscan-ts';

// Generate random vector
function randomVector(dim: number): number[] {
  return Array.from({ length: dim }, () => Math.random());
}

// Generate a cluster of vectors around a centroid
function generateCluster(
  centroid: number[],
  count: number,
  spread: number
): number[][] {
  return Array.from({ length: count }, () =>
    centroid.map((v) => v + (Math.random() - 0.5) * spread)
  );
}

// Test 1: Basic functionality with known clusters
function testBasicClustering() {
  console.log('=== Test 1: Basic Clustering (2D) ===');

  // Create 3 distinct clusters
  const cluster1 = generateCluster([0, 0], 20, 0.5);
  const cluster2 = generateCluster([10, 10], 20, 0.5);
  const cluster3 = generateCluster([0, 10], 20, 0.5);
  const noise = Array.from({ length: 5 }, () => [
    Math.random() * 20 - 5,
    Math.random() * 20 - 5,
  ]);

  const data = [...cluster1, ...cluster2, ...cluster3, ...noise];

  const hdbscan = new HDBSCAN({ minClusterSize: 5, minSamples: 3 });

  const start = performance.now();
  hdbscan.fit(data);
  const elapsed = performance.now() - start;

  const labels = hdbscan.labels_;
  const uniqueLabels = [...new Set(labels)];
  const clusterCount = uniqueLabels.filter((l) => l !== -1).length;
  const noiseCount = labels.filter((l) => l === -1).length;

  console.log(`  Points: ${data.length}`);
  console.log(`  Time: ${elapsed.toFixed(2)}ms`);
  console.log(`  Clusters found: ${clusterCount} (expected: 3)`);
  console.log(`  Noise points: ${noiseCount}`);
  console.log(`  Labels: ${uniqueLabels.join(', ')}`);
  console.log(
    `  Result: ${clusterCount === 3 ? '✅ PASS' : '⚠️  Found ' + clusterCount + ' clusters'}`
  );
  console.log();
}

// Test 2: High-dimensional embeddings (1536-dim like OpenAI)
function testHighDimensional() {
  console.log('=== Test 2: High-Dimensional (1536D) ===');

  const dim = 1536;

  // Create 3 clusters in high-dim space
  const centroid1 = randomVector(dim);
  const centroid2 = randomVector(dim);
  const centroid3 = randomVector(dim);

  const cluster1 = generateCluster(centroid1, 30, 0.1);
  const cluster2 = generateCluster(centroid2, 30, 0.1);
  const cluster3 = generateCluster(centroid3, 30, 0.1);

  const data = [...cluster1, ...cluster2, ...cluster3];

  const hdbscan = new HDBSCAN({ minClusterSize: 5, minSamples: 3 });

  const start = performance.now();
  hdbscan.fit(data);
  const elapsed = performance.now() - start;

  const labels = hdbscan.labels_;
  const uniqueLabels = [...new Set(labels)];
  const clusterCount = uniqueLabels.filter((l) => l !== -1).length;
  const noiseCount = labels.filter((l) => l === -1).length;

  console.log(`  Dimensions: ${dim}`);
  console.log(`  Points: ${data.length}`);
  console.log(`  Time: ${elapsed.toFixed(2)}ms`);
  console.log(`  Clusters found: ${clusterCount} (expected: 3)`);
  console.log(`  Noise points: ${noiseCount}`);
  console.log(
    `  Result: ${clusterCount === 3 ? '✅ PASS' : '⚠️  Found ' + clusterCount + ' clusters'}`
  );
  console.log();
}

// Test 3: Scaling test
function testScaling() {
  console.log('=== Test 3: Scaling (1536D) ===');

  const dim = 1536;
  const sizes = [50, 100, 200, 500];

  for (const size of sizes) {
    // Create clusters proportional to size
    const pointsPerCluster = Math.floor(size / 3);
    const centroid1 = randomVector(dim);
    const centroid2 = randomVector(dim);
    const centroid3 = randomVector(dim);

    const data = [
      ...generateCluster(centroid1, pointsPerCluster, 0.1),
      ...generateCluster(centroid2, pointsPerCluster, 0.1),
      ...generateCluster(centroid3, pointsPerCluster, 0.1),
    ];

    const hdbscan = new HDBSCAN({ minClusterSize: 5, minSamples: 3 });

    const start = performance.now();
    hdbscan.fit(data);
    const elapsed = performance.now() - start;

    const labels = hdbscan.labels_;
    const clusterCount = [...new Set(labels)].filter((l) => l !== -1).length;

    console.log(
      `  ${size.toString().padStart(3)} points: ${elapsed.toFixed(0).padStart(6)}ms | ${clusterCount} clusters`
    );
  }
  console.log();
}

// Test 4: Realistic user likes scenario
function testRealisticScenario() {
  console.log('=== Test 4: Realistic Scenario ===');
  console.log('  Simulating user with ~200 likes across varied interests\n');

  const dim = 1536;

  // Simulate a user with:
  // - 80 TypeScript/programming likes (tight cluster)
  // - 40 cooking likes (medium cluster)
  // - 30 board game likes (small cluster)
  // - 20 random/noise likes

  const programmingCentroid = randomVector(dim);
  const cookingCentroid = randomVector(dim);
  const boardGameCentroid = randomVector(dim);

  const data = [
    ...generateCluster(programmingCentroid, 80, 0.08), // Tight cluster
    ...generateCluster(cookingCentroid, 40, 0.12), // Medium spread
    ...generateCluster(boardGameCentroid, 30, 0.1), // Small cluster
    ...Array.from({ length: 20 }, () => randomVector(dim)), // Noise
  ];

  const hdbscan = new HDBSCAN({ minClusterSize: 10, minSamples: 5 });

  const start = performance.now();
  hdbscan.fit(data);
  const elapsed = performance.now() - start;

  const labels = hdbscan.labels_;
  const uniqueLabels = [...new Set(labels)];
  const clusterCount = uniqueLabels.filter((l) => l !== -1).length;
  const noiseCount = labels.filter((l) => l === -1).length;

  // Count members per cluster
  const clusterSizes: Record<number, number> = {};
  for (const label of labels) {
    clusterSizes[label] = (clusterSizes[label] || 0) + 1;
  }

  console.log(`  Total likes: ${data.length}`);
  console.log(`  Time: ${elapsed.toFixed(2)}ms`);
  console.log(`  Clusters found: ${clusterCount} (expected: 3)`);
  console.log(`  Noise points: ${noiseCount} (expected: ~20)`);
  console.log(`  Cluster sizes:`);
  for (const [label, size] of Object.entries(clusterSizes).sort(
    (a, b) => Number(b[1]) - Number(a[1])
  )) {
    const name = label === '-1' ? 'noise' : `cluster ${label}`;
    console.log(`    ${name}: ${size} points`);
  }
  console.log(
    `  Result: ${clusterCount === 3 ? '✅ PASS' : '⚠️  Found ' + clusterCount + ' clusters'}`
  );
  console.log();
}

// Run all tests
console.log('\n🧪 HDBSCAN-TS Test Suite\n');
console.log(
  'Testing with high-dimensional embeddings (OpenAI text-embedding-3-small)\n'
);

testBasicClustering();
testHighDimensional();
testScaling();
testRealisticScenario();

console.log('✅ Tests complete!');
