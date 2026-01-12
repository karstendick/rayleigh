/**
 * Explore a Bluesky user's likes using BIRCH clustering (via scikit-learn-ts)
 *
 * This script tests BIRCH clustering as a potential streaming-capable alternative
 * to HDBSCAN. It uses scikit-learn-ts which wraps Python's scikit-learn.
 *
 * Prerequisites:
 *   - Python >= 3.7 with numpy and scikit-learn installed
 *   - pip install numpy scikit-learn
 *
 * Usage:
 *   pnpm explore-likes:birch
 *   pnpm explore-likes:birch --threshold 0.5 --branching 50
 *   pnpm explore-likes:birch --n-clusters 10
 *
 * Options:
 *   --days <n>          Number of days of likes to analyze (default: 365)
 *   --dimensions <n>    Embedding dimensions: 256, 512, or 1536 (default: 1536)
 *   --threshold <n>     BIRCH threshold - radius of subclusters (default: 0.5)
 *   --branching <n>     BIRCH branching factor - max subclusters per node (default: 50)
 *   --n-clusters <n>    Optional: final number of clusters (default: auto)
 *   --auto-mdl          Use two-part MDL to automatically select optimal n_clusters
 *   --no-cache          Force refresh of likes and embeddings (ignore cache)
 *
 * Caching:
 *   Reuses the same cache as explore-likes.ts (output/cache/)
 *
 * Requires (in .env file):
 *   BLUESKY_AUTH_HANDLE - Your Bluesky handle (whose likes to analyze)
 *   BLUESKY_AUTH_PASSWORD - App password (create at bsky.app/settings/app-passwords)
 *   OPENAI_API_KEY - For generating embeddings
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { AtpAgent } from '@atproto/api';
import OpenAI from 'openai';
import { Birch, createPythonBridge } from 'sklearn';

// Type for the Python bridge returned by createPythonBridge
type PyBridge = Awaited<ReturnType<typeof createPythonBridge>>;

// Configuration
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_BATCH_SIZE = 100;
const CACHE_DIR = 'output/cache';
const FULL_EMBEDDING_DIMS = 1536;

// Memory profiling
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function logMemory(label: string): void {
  const mem = process.memoryUsage();
  console.log(
    `  [Memory @ ${label}] Heap: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}, RSS: ${formatBytes(mem.rss)}, External: ${formatBytes(mem.external)}`
  );
}

interface LikedPost {
  uri: string;
  cid: string;
  text: string;
  authorHandle: string;
  authorDisplayName: string;
}

interface ClusterReport {
  clusterId: number;
  size: number;
  centroid: number[];
  exemplars: LikedPost[]; // Posts closest to centroid (most representative)
  samples: LikedPost[]; // Temporal spread across cluster
  avgDistance: number; // Average distance to centroid (cohesion measure)
  sumSquaredDistances: number; // Sum of squared distances to centroid (for WCSS)
  descriptionLength: number; // Bits to encode cluster (MDL-inspired)
}

// Convert AT URI to Bluesky web URL
function postUrl(post: LikedPost): string {
  const rkey = post.uri.split('/').pop();
  return `https://bsky.app/profile/${post.authorHandle}/post/${rkey}`;
}

// Compute centroid of a set of embeddings
function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dims = embeddings[0].length;
  const centroid = new Array(dims).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dims; i++) {
      centroid[i] += emb[i];
    }
  }
  for (let i = 0; i < dims; i++) {
    centroid[i] /= embeddings.length;
  }
  return centroid;
}

// Compute Euclidean distance between two vectors
function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// Two-part MDL computation using principled information-theoretic formulation
//
// The key insight is that float32 (32 bits) provides a natural reference precision.
// When comparing clustered vs unclustered encoding, the precision ε cancels.
//
// Components:
// - Model cost: k × d × 32 bits (encoding k centroids at float32 precision)
// - Assignment cost: n × log2(k) bits (which cluster each point belongs to)
// - Residual cost: n × d × (1/2) × log2(σ²_within) (encoding residuals)
// - Baseline: n × d × (1/2) × log2(σ²_total) (encoding without clustering)
//
// The "savings" from clustering is the difference between baseline and clustered encoding.
// We minimize totalMDL = modelCost + assignmentCost + residualCost

// Bits per centroid coordinate. Float32 = 32, but centroids (averages) may not
// need full precision. Lower values favor more clusters in MDL selection.
const BITS_PER_CENTROID = 8; // Try 16 (float16) or 8 for more aggressive clustering

interface MDLResult {
  modelCost: number;
  assignmentCost: number;
  residualCost: number;
  totalMDL: number;
  numClusters: number;
  // For comparison
  baselineCost: number;
  savings: number;
  compressionRatio: number;
}

// Compute per-dimension variance of embeddings (assumes zero-mean or computes from data)
function computeTotalVariance(embeddings: number[][]): number {
  if (embeddings.length === 0) return 0;
  const n = embeddings.length;
  const d = embeddings[0].length;

  // Compute mean for each dimension
  const mean = new Array(d).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < d; i++) {
      mean[i] += emb[i];
    }
  }
  for (let i = 0; i < d; i++) {
    mean[i] /= n;
  }

  // Compute total variance (sum of per-dimension variances)
  let totalVariance = 0;
  for (const emb of embeddings) {
    for (let i = 0; i < d; i++) {
      const diff = emb[i] - mean[i];
      totalVariance += diff * diff;
    }
  }

  // Return per-dimension variance (average across dimensions)
  return totalVariance / (n * d);
}

function computeTwoPartMDL(
  clusters: ClusterReport[],
  dimensions: number,
  totalVariance: number,
  totalPoints?: number
): MDLResult {
  const k = clusters.length;
  const n = totalPoints ?? clusters.reduce((sum, c) => sum + c.size, 0);

  // Model cost: encoding k centroids at float32 precision
  const modelCost = k * dimensions * BITS_PER_CENTROID;

  // Assignment cost: which cluster each point belongs to
  // Each point needs log2(k) bits to specify its cluster
  const assignmentCost = n * Math.log2(k);

  // WCSS: total sum of squared distances from points to their centroids
  // Using the correct calculation: Σ (distance²) not Σ (n × avgDistance²)
  const totalWCSS = clusters.reduce((sum, c) => sum + c.sumSquaredDistances, 0);

  // Per-dimension within-cluster variance
  // WCSS gives total squared Euclidean distance; divide by n×d for per-dim variance
  const withinVariance = totalWCSS / (n * dimensions);

  // Variance reduction from clustering
  // This is the key insight: compression comes from reducing variance
  // Bits saved per dimension = ½ × log2(σ²_total / σ²_within)
  const epsilon = 1e-12;
  const varianceRatio =
    Math.max(totalVariance, epsilon) / Math.max(withinVariance, epsilon);

  // Variance savings: bits saved by encoding residuals instead of raw data
  // Always non-negative since within-cluster variance ≤ total variance
  const varianceSavings = n * dimensions * 0.5 * Math.log2(varianceRatio);

  // For MDL selection, we want to minimize: modelCost + assignmentCost - varianceSavings
  // Equivalently, maximize: varianceSavings - modelCost - assignmentCost
  const residualCost = -varianceSavings; // Negative because savings reduce cost
  const totalMDL = modelCost + assignmentCost + residualCost;

  // Baseline cost: encoding all points at float32 (no clustering)
  const baselineCost = n * dimensions * BITS_PER_CENTROID;

  // Savings: how much we save compared to raw float32 encoding
  // = variance savings - model cost - assignment cost
  const savings = varianceSavings - modelCost - assignmentCost;

  // Compression ratio: >1 means we save bits
  const compressionRatio = varianceSavings / (modelCost + assignmentCost);

  return {
    modelCost,
    assignmentCost,
    residualCost,
    totalMDL,
    numClusters: k,
    baselineCost,
    savings,
    compressionRatio,
  };
}

// Find optimal number of clusters using two-part MDL
// Grid searches over n_clusters values and returns the one with minimum total MDL
async function findOptimalClustersMDL(
  py: PyBridge,
  posts: LikedPost[],
  embeddings: number[][],
  threshold: number,
  branchingFactor: number,
  dimensions: number
): Promise<{
  optimalK: number;
  mdlResults: MDLResult[];
  bestClusters: ClusterReport[];
  bestLabels: number[];
  totalVariance: number;
}> {
  // Compute total variance once for baseline comparison
  const totalVariance = computeTotalVariance(embeddings);

  // Determine range of k to try based on data size
  // Start from 2, go up to sqrt(n) or 100, whichever is smaller
  const minK = 2;
  const maxK = Math.min(100, Math.max(10, Math.floor(Math.sqrt(posts.length))));

  // Generate candidate k values (logarithmic spacing for efficiency)
  const candidates: number[] = [];
  for (let k = minK; k <= maxK; k++) {
    // Include all small values, then space out for larger k
    if (k <= 20 || k % 5 === 0) {
      candidates.push(k);
    }
  }

  console.log(`\n=== MDL-based cluster selection ===`);
  console.log(`Total variance (per-dim): ${totalVariance.toExponential(4)}`);
  console.log(
    `Testing ${candidates.length} values of k from ${minK} to ${maxK}...`
  );
  logMemory('before MDL grid search');
  console.log('');
  console.log('| k | Model | Assign | Var.Savings | Net Savings | Ratio |');
  console.log('|---|-------|--------|-------------|-------------|-------|');

  const mdlResults: MDLResult[] = [];
  let bestSavings = Number.NEGATIVE_INFINITY;
  let bestK = minK;

  for (const k of candidates) {
    // Run BIRCH with this k (suppress output)
    const birch = new Birch({
      threshold,
      branching_factor: branchingFactor,
      n_clusters: k,
      compute_labels: true,
    });

    await birch.init(py);
    const labels: number[] = await birch.fit_predict({ X: embeddings });
    await birch.dispose();

    // Build cluster reports (simplified - just need sizes and distances)
    const clusterMap = new Map<number, { embedding: number[] }[]>();
    for (let i = 0; i < posts.length; i++) {
      const label = labels[i];
      if (!clusterMap.has(label)) {
        clusterMap.set(label, []);
      }
      clusterMap.get(label)!.push({ embedding: embeddings[i] });
    }

    // Compute cluster stats for MDL
    const tempClusters: ClusterReport[] = [];
    for (const [clusterId, members] of clusterMap.entries()) {
      const clusterEmbeddings = members.map((m) => m.embedding);
      const centroid = computeCentroid(clusterEmbeddings);

      const distances = members.map((m) =>
        euclideanDistance(m.embedding, centroid)
      );
      const avgDistance = distances.reduce((a, b) => a + b, 0) / members.length;
      // Sum of squared distances (for proper WCSS calculation)
      const sumSquaredDistances = distances.reduce((a, b) => a + b * b, 0);

      const epsilon = 1e-10;
      const descriptionLength =
        members.length * Math.log2(Math.max(avgDistance, epsilon));

      tempClusters.push({
        clusterId,
        size: members.length,
        centroid,
        exemplars: [],
        samples: [],
        avgDistance,
        sumSquaredDistances,
        descriptionLength,
      });
    }

    const mdl = computeTwoPartMDL(tempClusters, dimensions, totalVariance);
    mdlResults.push(mdl);

    // Variance savings = -residualCost (since residualCost = -varianceSavings)
    const varSavings = -mdl.residualCost;
    console.log(
      `| ${k.toString().padStart(2)} | ${mdl.modelCost.toFixed(0).padStart(5)} | ${mdl.assignmentCost.toFixed(0).padStart(6)} | ${varSavings.toFixed(0).padStart(11)} | ${mdl.savings.toFixed(0).padStart(11)} | ${mdl.compressionRatio.toFixed(2).padStart(5)} |${mdl.savings > bestSavings ? ' *' : ''}`
    );

    if (mdl.savings > bestSavings) {
      bestSavings = mdl.savings;
      bestK = k;
    }
  }

  console.log('');
  console.log(
    `Optimal k = ${bestK} (net savings = ${bestSavings.toFixed(0)} bits)`
  );
  logMemory('after MDL grid search');

  // Re-run with optimal k to get full cluster reports
  const { clusters, labels } = await clusterWithBirch(
    py,
    posts,
    embeddings,
    threshold,
    branchingFactor,
    bestK
  );

  return {
    optimalK: bestK,
    mdlResults,
    bestClusters: clusters,
    bestLabels: labels,
    totalVariance,
  };
}

// Parse command line arguments
function parseArgs(): {
  days: number;
  threshold: number;
  branchingFactor: number;
  nClusters: number | null;
  dimensions: number;
  noCache: boolean;
  autoMDL: boolean;
} {
  const args = process.argv.slice(2);
  let days = 365;
  let threshold = 0.5;
  let branchingFactor = 50;
  let nClusters: number | null = null;
  let dimensions = 1536;
  let noCache = false;
  let autoMDL = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      days = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--threshold' && args[i + 1]) {
      threshold = Number.parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--branching' && args[i + 1]) {
      branchingFactor = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--n-clusters' && args[i + 1]) {
      nClusters = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dimensions' && args[i + 1]) {
      dimensions = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--no-cache') {
      noCache = true;
    } else if (args[i] === '--auto-mdl') {
      autoMDL = true;
    }
  }

  return {
    days,
    threshold,
    branchingFactor,
    nClusters,
    dimensions,
    noCache,
    autoMDL,
  };
}

// Cache file paths (reuse same cache as explore-likes.ts)
function getCachePaths(handle: string, days: number) {
  const safeHandle = handle.replace(/\./g, '_');
  return {
    likes: `${CACHE_DIR}/likes-${safeHandle}-${days}d.json`,
    embeddings: `${CACHE_DIR}/embeddings-${safeHandle}-${days}d.json`,
  };
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function loadLikesCache(cachePath: string): LikedPost[] | null {
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  console.log(`Loading likes from cache: ${cachePath}`);
  const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  console.log(`  Loaded ${data.likes.length} cached likes`);
  return data.likes;
}

function saveLikesCache(cachePath: string, likes: LikedPost[]) {
  ensureCacheDir();
  const data = {
    cachedAt: new Date().toISOString(),
    count: likes.length,
    likes,
  };
  fs.writeFileSync(cachePath, JSON.stringify(data));
  console.log(`  Cached ${likes.length} likes to ${cachePath}`);
}

function loadEmbeddingsCache(cachePath: string): number[][] | null {
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  console.log(`Loading embeddings from cache: ${cachePath}`);
  const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  console.log(
    `  Loaded ${data.embeddings.length} cached embeddings (${data.dimensions} dims)`
  );
  return data.embeddings;
}

function saveEmbeddingsCache(
  cachePath: string,
  embeddings: number[][],
  dimensions: number
) {
  ensureCacheDir();
  const data = {
    cachedAt: new Date().toISOString(),
    count: embeddings.length,
    dimensions,
    embeddings,
  };
  fs.writeFileSync(cachePath, JSON.stringify(data));
  console.log(`  Cached ${embeddings.length} embeddings to ${cachePath}`);
}

function sliceEmbeddings(
  embeddings: number[][],
  targetDims: number
): number[][] {
  if (embeddings.length === 0) return embeddings;
  if (embeddings[0].length <= targetDims) return embeddings;
  console.log(
    `  Slicing embeddings from ${embeddings[0].length} to ${targetDims} dimensions`
  );
  return embeddings.map((e) => e.slice(0, targetDims));
}

async function fetchLikes(
  agent: AtpAgent,
  handle: string,
  days: number
): Promise<LikedPost[]> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const likes: LikedPost[] = [];
  let cursor: string | undefined;
  let page = 0;

  console.log(`Fetching likes for @${handle} from the last ${days} days...`);

  while (true) {
    page++;
    const response = await agent.app.bsky.feed.getActorLikes({
      actor: handle,
      limit: 100,
      cursor,
    });

    const feed = response.data.feed;
    if (feed.length === 0) break;

    let reachedCutoff = false;
    for (const item of feed) {
      const post = item.post;
      const record = post.record as { text?: string; createdAt?: string };

      if (!record.text) continue;

      const createdAt = new Date(record.createdAt || post.indexedAt);
      if (createdAt < cutoffDate) {
        reachedCutoff = true;
        break;
      }

      likes.push({
        uri: post.uri,
        cid: post.cid,
        text: record.text,
        authorHandle: post.author.handle,
        authorDisplayName: post.author.displayName || post.author.handle,
      });
    }

    if (reachedCutoff) break;

    cursor = response.data.cursor;
    if (!cursor) break;

    if (page % 5 === 0) {
      console.log(`  Fetched ${likes.length} likes so far (page ${page})...`);
    }

    await sleep(100);
  }

  console.log(
    `  Found ${likes.length} likes with text in the last ${days} days`
  );
  return likes;
}

async function generateEmbeddings(
  openai: OpenAI,
  posts: LikedPost[],
  dimensions: number
): Promise<number[][]> {
  console.log(`Generating embeddings for ${posts.length} posts...`);

  const embeddings: number[][] = [];

  for (let i = 0; i < posts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = posts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const texts = batch.map((p) => p.text);

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
      dimensions,
    });

    for (const item of response.data) {
      embeddings.push(item.embedding);
    }

    const progress = Math.min(i + EMBEDDING_BATCH_SIZE, posts.length);
    console.log(`  Embedded ${progress}/${posts.length} posts`);
  }

  return embeddings;
}

// Run BIRCH clustering via scikit-learn-ts
async function clusterWithBirch(
  py: PyBridge,
  posts: LikedPost[],
  embeddings: number[][],
  threshold: number,
  branchingFactor: number,
  nClusters: number | null
): Promise<{
  clusters: ClusterReport[];
  labels: number[];
}> {
  console.log(
    `Clustering ${posts.length} posts with BIRCH (threshold=${threshold}, branching=${branchingFactor}, n_clusters=${nClusters ?? 'auto'})...`
  );

  const start = performance.now();

  // Initialize BIRCH
  const birch = new Birch({
    threshold,
    branching_factor: branchingFactor,
    n_clusters: nClusters ?? undefined,
    compute_labels: true,
  });

  await birch.init(py);

  // Fit and get labels using fit_predict
  const labels: number[] = await birch.fit_predict({ X: embeddings });

  // Check how many subclusters the CF tree actually created
  const subclusterCenters: number[][] = await birch.subcluster_centers_;
  console.log(`  CF tree created ${subclusterCenters.length} subclusters`);

  const elapsed = performance.now() - start;
  console.log(`  BIRCH clustering completed in ${elapsed.toFixed(0)}ms`);

  // Clean up
  await birch.dispose();

  // Group posts by cluster
  const clusterMap = new Map<
    number,
    { post: LikedPost; embedding: number[] }[]
  >();

  for (let i = 0; i < posts.length; i++) {
    const label = labels[i];
    if (!clusterMap.has(label)) {
      clusterMap.set(label, []);
    }
    clusterMap.get(label)!.push({
      post: posts[i],
      embedding: embeddings[i],
    });
  }

  // Build cluster reports
  const clusters: ClusterReport[] = [];

  for (const [clusterId, members] of clusterMap.entries()) {
    const clusterEmbeddings = members.map((m) => m.embedding);
    const centroid = computeCentroid(clusterEmbeddings);

    // Compute exemplars: posts closest to centroid (most representative)
    const membersWithDistance = members.map((m) => ({
      ...m,
      distance: euclideanDistance(m.embedding, centroid),
    }));
    membersWithDistance.sort((a, b) => a.distance - b.distance);
    const exemplars = membersWithDistance.slice(0, 5).map((m) => m.post);

    // Compute cohesion metrics
    const totalDistance = membersWithDistance.reduce(
      (sum, m) => sum + m.distance,
      0
    );
    const avgDistance = totalDistance / members.length;
    // Sum of squared distances (for proper WCSS calculation)
    const sumSquaredDistances = membersWithDistance.reduce(
      (sum, m) => sum + m.distance * m.distance,
      0
    );

    // Description length (MDL-inspired): bits to encode residuals
    // DL = n * log2(avgDistance) - lower is better (tighter cluster)
    // Add small epsilon to avoid log(0) for singleton clusters
    const epsilon = 1e-10;
    const descriptionLength =
      members.length * Math.log2(Math.max(avgDistance, epsilon));

    // Sample posts from the cluster (temporal spread)
    const step = Math.max(1, Math.floor(members.length / 10));
    const samples: LikedPost[] = [];
    for (let i = 0; i < members.length && samples.length < 10; i += step) {
      samples.push(members[i].post);
    }

    clusters.push({
      clusterId,
      size: members.length,
      centroid,
      exemplars,
      samples,
      avgDistance,
      sumSquaredDistances,
      descriptionLength,
    });
  }

  // Sort by size
  clusters.sort((a, b) => b.size - a.size);

  console.log(`  Found ${clusters.length} clusters`);

  return { clusters, labels };
}

// Generate markdown report
function generateReport(
  handle: string,
  days: number,
  totalLikes: number,
  clusters: ClusterReport[],
  params: {
    dimensions: number;
    threshold: number;
    branchingFactor: number;
    nClusters: number | null;
    mdlResult: MDLResult | null;
  }
): string {
  const lines: string[] = [];

  lines.push(`# BIRCH Clustering Analysis: @${handle}`);
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Algorithm:** BIRCH (via scikit-learn-ts)`);
  lines.push(`**Time range:** Last ${days} days`);
  lines.push(`**Total likes analyzed:** ${totalLikes}`);
  lines.push('');
  lines.push('## Parameters');
  lines.push('');
  lines.push(`| Parameter | Value |`);
  lines.push(`|-----------|-------|`);
  lines.push(`| Embedding dimensions | ${params.dimensions} |`);
  lines.push(`| Threshold (subcluster radius) | ${params.threshold} |`);
  lines.push(`| Branching factor | ${params.branchingFactor} |`);
  lines.push(
    `| Target clusters | ${params.nClusters ?? 'auto (from subclusters)'} |`
  );
  lines.push('');
  lines.push(`**Clusters found:** ${clusters.length}`);
  lines.push('');

  // Note about BIRCH vs HDBSCAN
  lines.push(
    '> **Note:** Unlike HDBSCAN, BIRCH assigns all points to clusters'
  );
  lines.push(
    '> (no "noise" category). BIRCH is designed for streaming/incremental'
  );
  lines.push(
    '> updates via `partial_fit()`, making it suitable for online clustering.'
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  // Compute global cohesion stats for normalization
  const avgDistances = clusters.map((c) => c.avgDistance);
  const globalAvgDistance =
    avgDistances.reduce((a, b) => a + b, 0) / avgDistances.length;
  const totalDescriptionLength = clusters.reduce(
    (sum, c) => sum + c.descriptionLength,
    0
  );

  // Cohesion overview
  lines.push('## Cohesion Overview');
  lines.push('');

  // Show two-part MDL breakdown if available
  if (params.mdlResult) {
    const varSavings = -params.mdlResult.residualCost;
    lines.push('### Two-Part MDL (Information-Theoretic)');
    lines.push('');
    lines.push(
      'The MDL principle selects the number of clusters that maximizes compression.'
    );
    lines.push('');
    lines.push('**Costs (bits spent):**');
    lines.push('| Component | Bits | Description |');
    lines.push('|-----------|------|-------------|');
    lines.push(
      `| Model cost | ${params.mdlResult.modelCost.toLocaleString()} | ${clusters.length} centroids × ${params.dimensions} dims × 32 bits |`
    );
    lines.push(
      `| Assignment cost | ${Math.round(params.mdlResult.assignmentCost).toLocaleString()} | ${totalLikes} points × log₂(${clusters.length}) bits |`
    );
    lines.push(
      `| **Total cost** | **${Math.round(params.mdlResult.modelCost + params.mdlResult.assignmentCost).toLocaleString()}** | |`
    );
    lines.push('');
    lines.push('**Savings (bits saved from variance reduction):**');
    lines.push('| Component | Bits | Description |');
    lines.push('|-----------|------|-------------|');
    lines.push(
      `| Variance savings | ${Math.round(varSavings).toLocaleString()} | n × d × ½ × log₂(σ²_total / σ²_within) |`
    );
    lines.push('');
    lines.push('**Net result:**');
    lines.push('| Metric | Value | Interpretation |');
    lines.push('|--------|-------|----------------|');
    lines.push(
      `| Net savings | ${Math.round(params.mdlResult.savings).toLocaleString()} bits | Variance savings − costs |`
    );
    lines.push(
      `| Compression ratio | ${params.mdlResult.compressionRatio.toFixed(2)}× | Savings / cost (>1 = good) |`
    );
    lines.push('');
  }

  lines.push(
    `**Total description length:** ${totalDescriptionLength.toFixed(1)} bits`
  );
  lines.push(`**Average cluster radius:** ${globalAvgDistance.toFixed(4)}`);
  lines.push('');

  // Find tightest and loosest clusters (by relative cohesion)
  const clustersByTightness = [...clusters]
    .filter((c) => c.size >= 5) // Only consider non-tiny clusters
    .sort((a, b) => a.avgDistance - b.avgDistance);

  if (clustersByTightness.length >= 3) {
    lines.push('**Tightest clusters** (most cohesive):');
    for (const c of clustersByTightness.slice(0, 3)) {
      const relCohesion = (c.avgDistance / globalAvgDistance).toFixed(2);
      lines.push(
        `- Cluster ${c.clusterId}: radius ${c.avgDistance.toFixed(4)} (${relCohesion}x avg) - ${c.size} posts`
      );
    }
    lines.push('');

    lines.push('**Loosest clusters** (least cohesive):');
    for (const c of clustersByTightness.slice(-3).reverse()) {
      const relCohesion = (c.avgDistance / globalAvgDistance).toFixed(2);
      lines.push(
        `- Cluster ${c.clusterId}: radius ${c.avgDistance.toFixed(4)} (${relCohesion}x avg) - ${c.size} posts`
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // Summary table
  lines.push('## Cluster Summary');
  lines.push('');
  lines.push('| Cluster | Size | % of Total | Cohesion | Sample Post |');
  lines.push('|---------|------|------------|----------|-------------|');

  for (const cluster of clusters) {
    const pct = ((cluster.size / totalLikes) * 100).toFixed(1);
    const relCohesion = (cluster.avgDistance / globalAvgDistance).toFixed(2);
    const cohesionLabel =
      cluster.avgDistance < globalAvgDistance * 0.8
        ? `${relCohesion}x ✓`
        : cluster.avgDistance > globalAvgDistance * 1.2
          ? `${relCohesion}x ⚠`
          : `${relCohesion}x`;
    const preview = `${cluster.exemplars[0]?.text.slice(0, 40).replace(/\n/g, ' ')}...`;
    lines.push(
      `| ${cluster.clusterId} | ${cluster.size} | ${pct}% | ${cohesionLabel} | ${preview} |`
    );
  }
  lines.push('');

  // Size distribution
  lines.push('### Cluster Size Distribution');
  lines.push('');
  const tiny = clusters.filter((c) => c.size < 5).length;
  const small = clusters.filter((c) => c.size >= 5 && c.size < 20).length;
  const medium = clusters.filter((c) => c.size >= 20 && c.size < 100).length;
  const large = clusters.filter((c) => c.size >= 100).length;

  lines.push('| Size Range | Count |');
  lines.push('|------------|-------|');
  lines.push(`| Large (100+) | ${large} |`);
  lines.push(`| Medium (20-99) | ${medium} |`);
  lines.push(`| Small (5-19) | ${small} |`);
  lines.push(`| Tiny (<5) | ${tiny} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Detailed cluster sections (top 20)
  const clustersToShow = clusters.slice(0, 20);
  for (const cluster of clustersToShow) {
    const relCohesion = (cluster.avgDistance / globalAvgDistance).toFixed(2);
    const cohesionNote =
      cluster.avgDistance < globalAvgDistance * 0.8
        ? ' — tight ✓'
        : cluster.avgDistance > globalAvgDistance * 1.2
          ? ' — loose ⚠'
          : '';
    lines.push(
      `## Cluster ${cluster.clusterId} (${cluster.size} posts, cohesion: ${relCohesion}x${cohesionNote})`
    );
    lines.push('');

    // Exemplars: most representative posts (closest to centroid)
    lines.push('### Most representative posts');
    lines.push('');
    for (const exemplar of cluster.exemplars) {
      const preview = exemplar.text.slice(0, 150).replace(/\n/g, ' ');
      lines.push(
        `- [@${exemplar.authorHandle}](${postUrl(exemplar)}): ${preview}${exemplar.text.length > 150 ? '...' : ''}`
      );
    }
    lines.push('');

    // Samples: temporal spread
    if (cluster.size > 5) {
      lines.push('### Temporal spread');
      lines.push('');
      for (const sample of cluster.samples.slice(0, 5)) {
        const preview = sample.text.slice(0, 150).replace(/\n/g, ' ');
        lines.push(
          `- [@${sample.authorHandle}](${postUrl(sample)}): ${preview}${sample.text.length > 150 ? '...' : ''}`
        );
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  if (clusters.length > 20) {
    lines.push(`*...and ${clusters.length - 20} more clusters*`);
  }

  return lines.join('\n');
}

async function main() {
  const {
    days,
    threshold,
    branchingFactor,
    nClusters,
    dimensions,
    noCache,
    autoMDL,
  } = parseArgs();

  // Check for required environment variables
  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }

  if (!process.env.BLUESKY_AUTH_HANDLE || !process.env.BLUESKY_AUTH_PASSWORD) {
    console.error(
      'Error: BLUESKY_AUTH_HANDLE and BLUESKY_AUTH_PASSWORD are required'
    );
    process.exit(1);
  }

  const handle = process.env.BLUESKY_AUTH_HANDLE;
  const timestamp = new Date().toISOString().split('T')[0];
  const safeHandle = handle.replace(/\./g, '_');
  const nClustersStr = nClusters ? `-n${nClusters}` : autoMDL ? '-mdl' : '';
  const outputPath = `output/likes-birch-${safeHandle}-${timestamp}-d${dimensions}-t${threshold}${nClustersStr}.md`;
  const cachePaths = getCachePaths(handle, days);

  console.log(`\n=== BIRCH Clustering Explorer ===`);
  console.log(`Handle: @${handle}`);
  console.log(`Days: ${days}`);
  console.log(`Dimensions: ${dimensions}`);
  console.log(`Threshold: ${threshold}`);
  console.log(`Branching factor: ${branchingFactor}`);
  console.log(
    `Target clusters: ${autoMDL ? 'auto (MDL)' : (nClusters ?? 'auto')}`
  );
  console.log(`Cache: ${noCache ? 'disabled' : 'enabled'}`);
  console.log('');
  logMemory('startup');

  // Initialize Python bridge
  console.log('Initializing Python bridge...');
  const py = await createPythonBridge().catch((error) => {
    console.error('Error: Failed to initialize Python bridge.');
    console.error(
      'Make sure Python >= 3.7 is installed with numpy and scikit-learn:'
    );
    console.error('  pip install numpy scikit-learn');
    console.error('');
    console.error('Details:', error);
    process.exit(1);
  });
  console.log('  Python bridge ready');
  logMemory('after Python bridge');

  try {
    // Initialize clients
    const agent = new AtpAgent({ service: 'https://bsky.social' });
    const openai = new OpenAI();

    // Step 1: Get likes (from cache or API)
    let likes: LikedPost[];
    const cachedLikes = noCache ? null : loadLikesCache(cachePaths.likes);

    if (cachedLikes) {
      likes = cachedLikes;
    } else {
      console.log('Authenticating with Bluesky...');
      await agent.login({
        identifier: handle,
        password: process.env.BLUESKY_AUTH_PASSWORD,
      });
      console.log('  Authenticated\n');

      likes = await fetchLikes(agent, handle, days);
      saveLikesCache(cachePaths.likes, likes);
    }

    if (likes.length < 10) {
      console.error(`\nNot enough likes (${likes.length}) for clustering.`);
      process.exit(1);
    }
    logMemory('after loading likes');

    // Step 2: Get embeddings (from cache or API)
    let embeddings: number[][];
    const cachedEmbeddings = noCache
      ? null
      : loadEmbeddingsCache(cachePaths.embeddings);

    if (cachedEmbeddings) {
      embeddings = sliceEmbeddings(cachedEmbeddings, dimensions);
    } else {
      embeddings = await generateEmbeddings(openai, likes, FULL_EMBEDDING_DIMS);
      saveEmbeddingsCache(
        cachePaths.embeddings,
        embeddings,
        FULL_EMBEDDING_DIMS
      );
      embeddings = sliceEmbeddings(embeddings, dimensions);
    }
    logMemory('after loading embeddings');

    // Step 3: Cluster with BIRCH
    let clusters: ClusterReport[];
    let optimalK: number | null = null;
    let mdlResult: MDLResult | null = null;

    if (autoMDL) {
      // Use MDL to find optimal number of clusters
      const mdlSearch = await findOptimalClustersMDL(
        py,
        likes,
        embeddings,
        threshold,
        branchingFactor,
        dimensions
      );
      clusters = mdlSearch.bestClusters;
      optimalK = mdlSearch.optimalK;
      mdlResult = computeTwoPartMDL(
        clusters,
        dimensions,
        mdlSearch.totalVariance
      );
    } else {
      // Use specified n_clusters or BIRCH's auto mode
      const result = await clusterWithBirch(
        py,
        likes,
        embeddings,
        threshold,
        branchingFactor,
        nClusters
      );
      clusters = result.clusters;
      // Compute total variance for MDL calculation
      const totalVariance = computeTotalVariance(embeddings);
      mdlResult = computeTwoPartMDL(clusters, dimensions, totalVariance);
    }
    logMemory('after clustering');

    // Step 4: Generate report
    const report = generateReport(handle, days, likes.length, clusters, {
      dimensions,
      threshold,
      branchingFactor,
      nClusters: optimalK ?? nClusters,
      mdlResult,
    });

    // Step 5: Write output
    const outputDir = outputPath.substring(0, outputPath.lastIndexOf('/'));
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, report);
    console.log(`\nReport written to: ${outputPath}`);

    // Print summary
    console.log(`\n=== Summary ===`);
    console.log(`Total likes: ${likes.length}`);
    console.log(`Clusters: ${clusters.length}`);

    // Cohesion stats
    const avgDistances = clusters.map((c) => c.avgDistance);
    const globalAvgRadius =
      avgDistances.reduce((a, b) => a + b, 0) / avgDistances.length;
    const totalDL = clusters.reduce((sum, c) => sum + c.descriptionLength, 0);
    console.log(`Total description length: ${totalDL.toFixed(1)} bits`);
    console.log(`Average cluster radius: ${globalAvgRadius.toFixed(4)}`);

    for (const c of clusters.slice(0, 10)) {
      const relCohesion = (c.avgDistance / globalAvgRadius).toFixed(2);
      console.log(
        `  Cluster ${c.clusterId}: ${c.size} posts (cohesion: ${relCohesion}x)`
      );
    }
    if (clusters.length > 10) {
      console.log(`  ...and ${clusters.length - 10} more clusters`);
    }
  } finally {
    // Clean up Python bridge
    await py.disconnect();
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
