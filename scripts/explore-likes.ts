/**
 * Explore a Bluesky user's likes to discover interest clusters
 *
 * Usage:
 *   pnpm explore-likes
 *   pnpm explore-likes --days 180 --min-cluster 10
 *   pnpm explore-likes --dimensions 512 --min-cluster 5 --min-samples 3
 *
 * Options:
 *   --days <n>        Number of days of likes to analyze (default: 365)
 *   --dimensions <n>  Embedding dimensions: 256, 512, or 1536 (default: 1536)
 *   --min-cluster <n> Minimum posts to form a cluster (default: 5)
 *   --min-samples <n> HDBSCAN min samples - lower = less conservative (default: 1)
 *   --no-cache        Force refresh of likes and embeddings (ignore cache)
 *
 * Caching:
 *   Likes and embeddings (at 1536 dims) are cached in output/cache/
 *   Cached embeddings use Matryoshka slicing for lower dimensions
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
import { HDBSCAN } from 'hdbscan-ts';
import OpenAI from 'openai';

// Configuration
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_BATCH_SIZE = 100; // OpenAI allows up to 2048
const CACHE_DIR = 'output/cache';
const FULL_EMBEDDING_DIMS = 1536; // Cache at full resolution

// Convert AT URI to Bluesky web URL
function postUrl(post: LikedPost): string {
  // URI format: at://did:plc:xxx/app.bsky.feed.post/rkey
  const rkey = post.uri.split('/').pop();
  return `https://bsky.app/profile/${post.authorHandle}/post/${rkey}`;
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
  exemplars: {
    post: LikedPost;
    probability: number;
  }[];
  samples: LikedPost[];
}

interface NoiseAnalysis {
  // Text length distribution
  textLengthStats: {
    min: number;
    max: number;
    median: number;
    mean: number;
    shortPosts: number; // < 50 chars
    mediumPosts: number; // 50-200 chars
    longPosts: number; // > 200 chars
  };
  // Author frequency
  topAuthors: { handle: string; count: number }[];
  uniqueAuthors: number;
  // Near-miss analysis: posts that almost clustered
  nearMisses: {
    post: LikedPost;
    nearestClusterId: number;
    distance: number;
  }[];
  // Sub-clustering of noise
  subClusters: {
    clusterId: number;
    size: number;
    samples: LikedPost[];
  }[];
  subClusterNoise: number; // Posts that didn't fit even sub-clusters
}

interface AuthorStats {
  handle: string;
  totalLikes: number;
  clusteredLikes: number;
  noiseLikes: number;
  clusterIds: number[]; // Which clusters their posts appear in
  topCluster: number | null; // Most common cluster
}

interface AuthorAnalysis {
  // Overall stats
  totalAuthors: number;
  totalLikes: number;

  // Distribution buckets
  authorsWithOneLike: number;
  authorsWith2to4Likes: number;
  authorsWith5to9Likes: number;
  authorsWith10PlusLikes: number;

  // Coverage analysis
  likesFromTopAuthors: number; // Likes from authors with 5+ likes
  likesFromOneShotAuthors: number; // Likes from authors with only 1 like

  // Clustering effectiveness by author engagement
  clusteredLikesFromHighEngagement: number; // Clustered likes from 5+ like authors
  clusteredLikesFromLowEngagement: number; // Clustered likes from 1-4 like authors

  // Signal coverage
  postsWithAuthorSignal: number; // Posts from authors with 2+ likes
  postsWithTopicSignal: number; // Posts that clustered
  postsWithEitherSignal: number; // Posts with author OR topic signal
  postsWithBothSignals: number; // Posts with author AND topic signal
  postsWithNoSignal: number; // Posts with neither signal (unexplained)

  // All authors sorted by like count
  allAuthors: AuthorStats[];
}

// Cosine distance between two vectors (1 - cosine similarity)
function cosineDistance(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
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

// Parse command line arguments
function parseArgs(): {
  days: number;
  minClusterSize: number;
  minSamples: number;
  dimensions: number;
  noCache: boolean;
} {
  const args = process.argv.slice(2);
  let days = 365;
  let minClusterSize = 5;
  let minSamples = 1;
  let dimensions = 1536;
  let noCache = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      days = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--min-cluster' && args[i + 1]) {
      minClusterSize = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--min-samples' && args[i + 1]) {
      minSamples = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dimensions' && args[i + 1]) {
      dimensions = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--no-cache') {
      noCache = true;
    }
  }

  return { days, minClusterSize, minSamples, dimensions, noCache };
}

// Cache file paths
function getCachePaths(handle: string, days: number) {
  const safeHandle = handle.replace(/\./g, '_');
  return {
    likes: `${CACHE_DIR}/likes-${safeHandle}-${days}d.json`,
    embeddings: `${CACHE_DIR}/embeddings-${safeHandle}-${days}d.json`,
  };
}

// Ensure cache directory exists
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// Load likes from cache
function loadLikesCache(cachePath: string): LikedPost[] | null {
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  console.log(`Loading likes from cache: ${cachePath}`);
  const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  console.log(`  Loaded ${data.likes.length} cached likes`);
  return data.likes;
}

// Save likes to cache
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

// Load embeddings from cache
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

// Save embeddings to cache
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

// Slice embeddings to target dimensions (Matryoshka property)
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

// Fetch all likes for a user within the date range
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

      // Skip posts without text
      if (!record.text) continue;

      // Check date - use post's createdAt as proxy for like time
      // (API returns likes in reverse chronological order)
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

    // Progress update
    if (page % 5 === 0) {
      console.log(`  Fetched ${likes.length} likes so far (page ${page})...`);
    }

    // Small delay to be nice to the API
    await sleep(100);
  }

  console.log(
    `  Found ${likes.length} likes with text in the last ${days} days`
  );
  return likes;
}

// Generate embeddings for posts in batches
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

// Run HDBSCAN and extract cluster information
function clusterPosts(
  posts: LikedPost[],
  embeddings: number[][],
  minClusterSize: number,
  minSamples: number
): {
  clusters: ClusterReport[];
  noise: LikedPost[];
  noiseEmbeddings: number[][];
  labels: number[];
} {
  console.log(
    `Clustering ${posts.length} posts (minClusterSize=${minClusterSize}, minSamples=${minSamples})...`
  );

  const hdbscan = new HDBSCAN({
    minClusterSize,
    minSamples,
  });

  const start = performance.now();
  hdbscan.fit(embeddings);
  const elapsed = performance.now() - start;

  const labels = hdbscan.labels_;
  const probabilities = hdbscan.probabilities_;

  console.log(`  Clustering completed in ${elapsed.toFixed(0)}ms`);

  // Group posts by cluster
  const clusterMap = new Map<
    number,
    { post: LikedPost; embedding: number[]; probability: number }[]
  >();
  const noise: LikedPost[] = [];
  const noiseEmbeddings: number[][] = [];

  for (let i = 0; i < posts.length; i++) {
    const label = labels[i];
    const prob = probabilities[i];

    if (label === -1) {
      noise.push(posts[i]);
      noiseEmbeddings.push(embeddings[i]);
    } else {
      if (!clusterMap.has(label)) {
        clusterMap.set(label, []);
      }
      clusterMap.get(label)!.push({
        post: posts[i],
        embedding: embeddings[i],
        probability: prob,
      });
    }
  }

  // Build cluster reports with exemplars and centroids
  const clusters: ClusterReport[] = [];

  for (const [clusterId, members] of clusterMap.entries()) {
    // Sort by probability (highest = most central)
    members.sort((a, b) => b.probability - a.probability);

    // Compute centroid for this cluster
    const clusterEmbeddings = members.map((m) => m.embedding);
    const centroid = computeCentroid(clusterEmbeddings);

    // Top 5 by probability are exemplars
    const exemplars = members.slice(0, 5).map((m) => ({
      post: m.post,
      probability: m.probability,
    }));

    // Get a diverse sample (not just top exemplars)
    // Take every Nth post to spread across the cluster
    const sampleIndices: number[] = [];
    const step = Math.max(1, Math.floor(members.length / 10));
    for (
      let i = 0;
      i < members.length && sampleIndices.length < 10;
      i += step
    ) {
      sampleIndices.push(i);
    }
    const samples = sampleIndices.map((i) => members[i].post);

    clusters.push({
      clusterId,
      size: members.length,
      centroid,
      exemplars,
      samples,
    });
  }

  // Sort clusters by size (largest first)
  clusters.sort((a, b) => b.size - a.size);

  console.log(
    `  Found ${clusters.length} clusters, ${noise.length} noise posts`
  );

  return { clusters, noise, noiseEmbeddings, labels };
}

// Analyze noise posts to understand why they didn't cluster
function analyzeNoise(
  noisePosts: LikedPost[],
  noiseEmbeddings: number[][],
  clusters: ClusterReport[],
  minClusterSize: number
): NoiseAnalysis {
  console.log(`Analyzing ${noisePosts.length} noise posts...`);

  // 1. Text length statistics
  const lengths = noisePosts.map((p) => p.text.length).sort((a, b) => a - b);
  const shortPosts = lengths.filter((l) => l < 50).length;
  const mediumPosts = lengths.filter((l) => l >= 50 && l <= 200).length;
  const longPosts = lengths.filter((l) => l > 200).length;
  const median =
    lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)] : 0;
  const mean =
    lengths.length > 0
      ? lengths.reduce((a, b) => a + b, 0) / lengths.length
      : 0;

  const textLengthStats = {
    min: lengths[0] || 0,
    max: lengths[lengths.length - 1] || 0,
    median,
    mean,
    shortPosts,
    mediumPosts,
    longPosts,
  };

  console.log(
    `  Text lengths: short=${shortPosts}, medium=${mediumPosts}, long=${longPosts}`
  );

  // 2. Author frequency
  const authorCounts = new Map<string, number>();
  for (const post of noisePosts) {
    const count = authorCounts.get(post.authorHandle) || 0;
    authorCounts.set(post.authorHandle, count + 1);
  }
  const topAuthors = [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([handle, count]) => ({ handle, count }));

  console.log(`  Unique authors in noise: ${authorCounts.size}`);

  // 3. Near-miss analysis: find closest cluster for each noise post
  const nearMisses: NoiseAnalysis['nearMisses'] = [];

  if (clusters.length > 0 && noiseEmbeddings.length > 0) {
    for (let i = 0; i < noisePosts.length; i++) {
      const embedding = noiseEmbeddings[i];
      let minDistance = Number.POSITIVE_INFINITY;
      let nearestClusterId = -1;

      for (const cluster of clusters) {
        const distance = cosineDistance(embedding, cluster.centroid);
        if (distance < minDistance) {
          minDistance = distance;
          nearestClusterId = cluster.clusterId;
        }
      }

      nearMisses.push({
        post: noisePosts[i],
        nearestClusterId,
        distance: minDistance,
      });
    }

    // Sort by distance (closest first) and take top 20
    nearMisses.sort((a, b) => a.distance - b.distance);
  }

  const closeNearMisses = nearMisses.filter((nm) => nm.distance < 0.3).length;
  console.log(`  Near-misses (distance < 0.3): ${closeNearMisses}`);

  // 4. Sub-clustering: try to find structure in noise with lower threshold
  const subClusters: NoiseAnalysis['subClusters'] = [];
  let subClusterNoise = noisePosts.length;

  if (noiseEmbeddings.length >= 6) {
    // Need at least 6 points for minClusterSize=3
    const subMinCluster = Math.max(2, Math.floor(minClusterSize / 2));
    console.log(
      `  Sub-clustering noise with minClusterSize=${subMinCluster}...`
    );

    const subHdbscan = new HDBSCAN({
      minClusterSize: subMinCluster,
      minSamples: 1,
    });

    const subStart = performance.now();
    subHdbscan.fit(noiseEmbeddings);
    const subElapsed = performance.now() - subStart;

    const subLabels = subHdbscan.labels_;

    // Group by sub-cluster
    const subClusterMap = new Map<number, LikedPost[]>();
    let subNoiseCount = 0;

    for (let i = 0; i < noisePosts.length; i++) {
      const label = subLabels[i];
      if (label === -1) {
        subNoiseCount++;
      } else {
        if (!subClusterMap.has(label)) {
          subClusterMap.set(label, []);
        }
        subClusterMap.get(label)!.push(noisePosts[i]);
      }
    }

    subClusterNoise = subNoiseCount;

    // Build sub-cluster reports
    for (const [clusterId, posts] of subClusterMap.entries()) {
      subClusters.push({
        clusterId,
        size: posts.length,
        samples: posts.slice(0, 5),
      });
    }

    subClusters.sort((a, b) => b.size - a.size);

    console.log(
      `  Sub-clustering completed in ${subElapsed.toFixed(0)}ms: ${subClusters.length} sub-clusters, ${subNoiseCount} still noise`
    );
  }

  return {
    textLengthStats,
    topAuthors,
    uniqueAuthors: authorCounts.size,
    nearMisses: nearMisses.slice(0, 20), // Top 20 closest
    subClusters,
    subClusterNoise,
  };
}

// Analyze authors across all likes to understand engagement patterns
function analyzeAuthors(posts: LikedPost[], labels: number[]): AuthorAnalysis {
  console.log(`Analyzing author patterns across ${posts.length} likes...`);

  // Build per-author stats
  const authorMap = new Map<string, AuthorStats>();

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const label = labels[i];
    const handle = post.authorHandle;

    if (!authorMap.has(handle)) {
      authorMap.set(handle, {
        handle,
        totalLikes: 0,
        clusteredLikes: 0,
        noiseLikes: 0,
        clusterIds: [],
        topCluster: null,
      });
    }

    const stats = authorMap.get(handle)!;
    stats.totalLikes++;

    if (label === -1) {
      stats.noiseLikes++;
    } else {
      stats.clusteredLikes++;
      if (!stats.clusterIds.includes(label)) {
        stats.clusterIds.push(label);
      }
    }
  }

  // Calculate topCluster for each author (most common cluster)
  for (const stats of authorMap.values()) {
    if (stats.clusterIds.length > 0) {
      // Count occurrences of each cluster for this author
      const clusterCounts = new Map<number, number>();
      for (let i = 0; i < posts.length; i++) {
        if (posts[i].authorHandle === stats.handle && labels[i] !== -1) {
          const count = clusterCounts.get(labels[i]) || 0;
          clusterCounts.set(labels[i], count + 1);
        }
      }
      // Find the most common cluster
      let maxCount = 0;
      for (const [clusterId, count] of clusterCounts.entries()) {
        if (count > maxCount) {
          maxCount = count;
          stats.topCluster = clusterId;
        }
      }
    }
  }

  // Sort authors by total likes (descending)
  const allAuthors = [...authorMap.values()].sort(
    (a, b) => b.totalLikes - a.totalLikes
  );

  // Distribution buckets
  let authorsWithOneLike = 0;
  let authorsWith2to4Likes = 0;
  let authorsWith5to9Likes = 0;
  let authorsWith10PlusLikes = 0;

  // Coverage analysis
  let likesFromTopAuthors = 0; // 5+ likes
  let likesFromOneShotAuthors = 0; // 1 like

  // Clustering effectiveness
  let clusteredLikesFromHighEngagement = 0; // 5+ like authors
  let clusteredLikesFromLowEngagement = 0; // 1-4 like authors

  for (const author of allAuthors) {
    if (author.totalLikes === 1) {
      authorsWithOneLike++;
      likesFromOneShotAuthors += author.totalLikes;
      clusteredLikesFromLowEngagement += author.clusteredLikes;
    } else if (author.totalLikes <= 4) {
      authorsWith2to4Likes++;
      clusteredLikesFromLowEngagement += author.clusteredLikes;
    } else if (author.totalLikes <= 9) {
      authorsWith5to9Likes++;
      likesFromTopAuthors += author.totalLikes;
      clusteredLikesFromHighEngagement += author.clusteredLikes;
    } else {
      authorsWith10PlusLikes++;
      likesFromTopAuthors += author.totalLikes;
      clusteredLikesFromHighEngagement += author.clusteredLikes;
    }
  }

  console.log(`  Total unique authors: ${allAuthors.length}`);
  console.log(`  Authors with 10+ likes: ${authorsWith10PlusLikes}`);
  console.log(`  Authors with 5-9 likes: ${authorsWith5to9Likes}`);
  console.log(`  Authors with 2-4 likes: ${authorsWith2to4Likes}`);
  console.log(`  Authors with 1 like: ${authorsWithOneLike}`);

  // Signal coverage analysis
  // For each post, determine which signals apply
  let postsWithAuthorSignal = 0; // From authors with 2+ likes
  let postsWithTopicSignal = 0; // Clustered
  let postsWithBothSignals = 0; // Both author AND topic
  let postsWithNoSignal = 0; // Neither signal

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const label = labels[i];
    const authorStats = authorMap.get(post.authorHandle)!;

    const hasAuthorSignal = authorStats.totalLikes >= 2;
    const hasTopicSignal = label !== -1;

    if (hasAuthorSignal) postsWithAuthorSignal++;
    if (hasTopicSignal) postsWithTopicSignal++;
    if (hasAuthorSignal && hasTopicSignal) postsWithBothSignals++;
    if (!hasAuthorSignal && !hasTopicSignal) postsWithNoSignal++;
  }

  const postsWithEitherSignal =
    postsWithAuthorSignal + postsWithTopicSignal - postsWithBothSignals;

  console.log(`  Signal coverage:`);
  console.log(
    `    Author signal (2+ likes): ${postsWithAuthorSignal} (${((postsWithAuthorSignal / posts.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `    Topic signal (clustered): ${postsWithTopicSignal} (${((postsWithTopicSignal / posts.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `    Either signal: ${postsWithEitherSignal} (${((postsWithEitherSignal / posts.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `    No signal: ${postsWithNoSignal} (${((postsWithNoSignal / posts.length) * 100).toFixed(1)}%)`
  );

  return {
    totalAuthors: allAuthors.length,
    totalLikes: posts.length,
    authorsWithOneLike,
    authorsWith2to4Likes,
    authorsWith5to9Likes,
    authorsWith10PlusLikes,
    likesFromTopAuthors,
    likesFromOneShotAuthors,
    clusteredLikesFromHighEngagement,
    clusteredLikesFromLowEngagement,
    postsWithAuthorSignal,
    postsWithTopicSignal,
    postsWithEitherSignal,
    postsWithBothSignals,
    postsWithNoSignal,
    allAuthors,
  };
}

// Generate markdown report
function generateReport(
  handle: string,
  days: number,
  totalLikes: number,
  clusters: ClusterReport[],
  noise: LikedPost[],
  noiseAnalysis: NoiseAnalysis | null,
  authorAnalysis: AuthorAnalysis | null,
  params: { dimensions: number; minClusterSize: number; minSamples: number }
): string {
  const lines: string[] = [];

  lines.push(`# Likes Analysis: @${handle}`);
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Time range:** Last ${days} days`);
  lines.push(`**Total likes analyzed:** ${totalLikes}`);
  lines.push('');
  lines.push('## Parameters');
  lines.push('');
  lines.push(`| Parameter | Value |`);
  lines.push(`|-----------|-------|`);
  lines.push(`| Embedding dimensions | ${params.dimensions} |`);
  lines.push(`| minClusterSize | ${params.minClusterSize} |`);
  lines.push(`| minSamples | ${params.minSamples} |`);
  lines.push('');
  lines.push(`**Clusters found:** ${clusters.length}`);
  lines.push(
    `**Noise (unclustered):** ${noise.length} posts (${((noise.length / totalLikes) * 100).toFixed(1)}%)`
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  // Summary table
  lines.push('## Cluster Summary');
  lines.push('');
  lines.push('| Cluster | Size | % of Total | Top Exemplar Preview |');
  lines.push('|---------|------|------------|---------------------|');

  for (const cluster of clusters) {
    const pct = ((cluster.size / totalLikes) * 100).toFixed(1);
    const preview = `${cluster.exemplars[0]?.post.text.slice(0, 60).replace(/\n/g, ' ')}...`;
    lines.push(
      `| ${cluster.clusterId} | ${cluster.size} | ${pct}% | ${preview} |`
    );
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Detailed cluster sections
  for (const cluster of clusters) {
    lines.push(`## Cluster ${cluster.clusterId} (${cluster.size} posts)`);
    lines.push('');
    lines.push('### Exemplars (most representative)');
    lines.push('');

    for (let i = 0; i < cluster.exemplars.length; i++) {
      const ex = cluster.exemplars[i];
      lines.push(
        `**${i + 1}. [@${ex.post.authorHandle}](${postUrl(ex.post)})** (probability: ${ex.probability.toFixed(3)})`
      );
      lines.push('');
      lines.push(`> ${ex.post.text.replace(/\n/g, '\n> ')}`);
      lines.push('');
    }

    lines.push('### Sample posts');
    lines.push('');

    for (const sample of cluster.samples.slice(0, 5)) {
      const preview = sample.text.slice(0, 150).replace(/\n/g, ' ');
      lines.push(
        `- [@${sample.authorHandle}](${postUrl(sample)}): ${preview}${sample.text.length > 150 ? '...' : ''}`
      );
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Noise Analysis section
  if (noise.length > 0 && noiseAnalysis) {
    lines.push('## Noise Analysis');
    lines.push('');
    lines.push(
      `${noise.length} posts (${((noise.length / totalLikes) * 100).toFixed(1)}%) didn't fit into any cluster. Here's what we found:`
    );
    lines.push('');

    // Text length breakdown
    lines.push('### Text Length Distribution');
    lines.push('');
    const stats = noiseAnalysis.textLengthStats;
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(
      `| Short posts (<50 chars) | ${stats.shortPosts} (${((stats.shortPosts / noise.length) * 100).toFixed(1)}%) |`
    );
    lines.push(
      `| Medium posts (50-200 chars) | ${stats.mediumPosts} (${((stats.mediumPosts / noise.length) * 100).toFixed(1)}%) |`
    );
    lines.push(
      `| Long posts (>200 chars) | ${stats.longPosts} (${((stats.longPosts / noise.length) * 100).toFixed(1)}%) |`
    );
    lines.push(`| Mean length | ${stats.mean.toFixed(0)} chars |`);
    lines.push(`| Median length | ${stats.median} chars |`);
    lines.push('');

    // Author frequency
    lines.push('### Top Authors in Noise');
    lines.push('');
    lines.push(
      `You liked posts from **${noiseAnalysis.uniqueAuthors}** unique authors that didn't cluster.`
    );
    lines.push('');
    if (noiseAnalysis.topAuthors.length > 0) {
      lines.push('| Author | Unclustered Likes |');
      lines.push('|--------|-------------------|');
      for (const author of noiseAnalysis.topAuthors.slice(0, 10)) {
        lines.push(`| @${author.handle} | ${author.count} |`);
      }
      lines.push('');
    }

    // Near-miss analysis
    lines.push('### Near Misses (Almost Clustered)');
    lines.push('');
    lines.push(
      "These posts were closest to existing clusters but didn't quite fit:"
    );
    lines.push('');
    for (const nm of noiseAnalysis.nearMisses.slice(0, 10)) {
      const preview = nm.post.text.slice(0, 80).replace(/\n/g, ' ');
      lines.push(
        `- **Cluster ${nm.nearestClusterId}** (dist: ${nm.distance.toFixed(3)}): [@${nm.post.authorHandle}](${postUrl(nm.post)}): ${preview}${nm.post.text.length > 80 ? '...' : ''}`
      );
    }
    lines.push('');

    // Sub-clustering results
    if (noiseAnalysis.subClusters.length > 0) {
      lines.push('### Hidden Structure in Noise (Sub-clusters)');
      lines.push('');
      lines.push(
        `Re-clustering noise with lower threshold found **${noiseAnalysis.subClusters.length}** sub-clusters:`
      );
      lines.push('');

      for (const sub of noiseAnalysis.subClusters.slice(0, 10)) {
        lines.push(`#### Sub-cluster ${sub.clusterId} (${sub.size} posts)`);
        lines.push('');
        for (const sample of sub.samples.slice(0, 3)) {
          const preview = sample.text.slice(0, 100).replace(/\n/g, ' ');
          lines.push(
            `- [@${sample.authorHandle}](${postUrl(sample)}): ${preview}${sample.text.length > 100 ? '...' : ''}`
          );
        }
        lines.push('');
      }

      lines.push(
        `*${noiseAnalysis.subClusterNoise} posts still unclustered after sub-clustering*`
      );
      lines.push('');
    }

    lines.push('---');
    lines.push('');

    // Random sample of noise
    lines.push('### Sample of Unclustered Posts');
    lines.push('');
    const noiseSample = noise.slice(0, 15);
    for (const post of noiseSample) {
      const preview = post.text.slice(0, 100).replace(/\n/g, ' ');
      lines.push(
        `- [@${post.authorHandle}](${postUrl(post)}): ${preview}${post.text.length > 100 ? '...' : ''}`
      );
    }

    if (noise.length > 15) {
      lines.push('');
      lines.push(`*...and ${noise.length - 15} more unclustered posts*`);
    }
  }

  // Author Analysis section
  if (authorAnalysis) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Signal Coverage Analysis');
    lines.push('');
    lines.push(
      'How much of your like behavior can be explained by author and topic signals?'
    );
    lines.push('');

    // Signal coverage table
    lines.push('| Signal | Posts | % of Total |');
    lines.push('|--------|-------|------------|');
    lines.push(
      `| Author signal (liked author 2+ times) | ${authorAnalysis.postsWithAuthorSignal} | ${((authorAnalysis.postsWithAuthorSignal / authorAnalysis.totalLikes) * 100).toFixed(1)}% |`
    );
    lines.push(
      `| Topic signal (clustered) | ${authorAnalysis.postsWithTopicSignal} | ${((authorAnalysis.postsWithTopicSignal / authorAnalysis.totalLikes) * 100).toFixed(1)}% |`
    );
    lines.push(
      `| **Either signal** | **${authorAnalysis.postsWithEitherSignal}** | **${((authorAnalysis.postsWithEitherSignal / authorAnalysis.totalLikes) * 100).toFixed(1)}%** |`
    );
    lines.push(
      `| Both signals | ${authorAnalysis.postsWithBothSignals} | ${((authorAnalysis.postsWithBothSignals / authorAnalysis.totalLikes) * 100).toFixed(1)}% |`
    );
    lines.push(
      `| **No signal (unexplained)** | **${authorAnalysis.postsWithNoSignal}** | **${((authorAnalysis.postsWithNoSignal / authorAnalysis.totalLikes) * 100).toFixed(1)}%** |`
    );
    lines.push('');

    lines.push('---');
    lines.push('');
    lines.push('## Author Analysis');
    lines.push('');
    lines.push(
      `You liked posts from **${authorAnalysis.totalAuthors}** unique authors.`
    );
    lines.push('');

    // Distribution table
    lines.push('### Author Engagement Distribution');
    lines.push('');
    lines.push('| Likes per Author | # Authors | % of Authors |');
    lines.push('|------------------|-----------|--------------|');

    const pctOne = (
      (authorAnalysis.authorsWithOneLike / authorAnalysis.totalAuthors) *
      100
    ).toFixed(1);
    const pct2to4 = (
      (authorAnalysis.authorsWith2to4Likes / authorAnalysis.totalAuthors) *
      100
    ).toFixed(1);
    const pct5to9 = (
      (authorAnalysis.authorsWith5to9Likes / authorAnalysis.totalAuthors) *
      100
    ).toFixed(1);
    const pct10Plus = (
      (authorAnalysis.authorsWith10PlusLikes / authorAnalysis.totalAuthors) *
      100
    ).toFixed(1);

    lines.push(
      `| 1 like | ${authorAnalysis.authorsWithOneLike} | ${pctOne}% |`
    );
    lines.push(
      `| 2-4 likes | ${authorAnalysis.authorsWith2to4Likes} | ${pct2to4}% |`
    );
    lines.push(
      `| 5-9 likes | ${authorAnalysis.authorsWith5to9Likes} | ${pct5to9}% |`
    );
    lines.push(
      `| 10+ likes | ${authorAnalysis.authorsWith10PlusLikes} | ${pct10Plus}% |`
    );
    lines.push('');

    // Coverage analysis
    lines.push('### Like Coverage by Author Engagement');
    lines.push('');
    const pctFromTop = (
      (authorAnalysis.likesFromTopAuthors / authorAnalysis.totalLikes) *
      100
    ).toFixed(1);
    const pctFromOneShot = (
      (authorAnalysis.likesFromOneShotAuthors / authorAnalysis.totalLikes) *
      100
    ).toFixed(1);
    const likesFrom2to4 =
      authorAnalysis.totalLikes -
      authorAnalysis.likesFromTopAuthors -
      authorAnalysis.likesFromOneShotAuthors;
    const pctFrom2to4 = (
      (likesFrom2to4 / authorAnalysis.totalLikes) *
      100
    ).toFixed(1);

    lines.push('| Author Tier | Likes | % of Total |');
    lines.push('|-------------|-------|------------|');
    lines.push(
      `| High engagement (5+ likes) | ${authorAnalysis.likesFromTopAuthors} | ${pctFromTop}% |`
    );
    lines.push(
      `| Medium engagement (2-4 likes) | ${likesFrom2to4} | ${pctFrom2to4}% |`
    );
    lines.push(
      `| One-shot (1 like) | ${authorAnalysis.likesFromOneShotAuthors} | ${pctFromOneShot}% |`
    );
    lines.push('');

    // Clustering effectiveness by engagement
    lines.push('### Clustering Effectiveness by Author Engagement');
    lines.push('');
    const highEngagementTotal = authorAnalysis.likesFromTopAuthors;
    const lowEngagementTotal =
      authorAnalysis.totalLikes - authorAnalysis.likesFromTopAuthors;

    const highClusterRate =
      highEngagementTotal > 0
        ? (
            (authorAnalysis.clusteredLikesFromHighEngagement /
              highEngagementTotal) *
            100
          ).toFixed(1)
        : '0';
    const lowClusterRate =
      lowEngagementTotal > 0
        ? (
            (authorAnalysis.clusteredLikesFromLowEngagement /
              lowEngagementTotal) *
            100
          ).toFixed(1)
        : '0';

    lines.push('| Author Tier | Clustered | Total | Cluster Rate |');
    lines.push('|-------------|-----------|-------|--------------|');
    lines.push(
      `| High engagement (5+) | ${authorAnalysis.clusteredLikesFromHighEngagement} | ${highEngagementTotal} | ${highClusterRate}% |`
    );
    lines.push(
      `| Low engagement (1-4) | ${authorAnalysis.clusteredLikesFromLowEngagement} | ${lowEngagementTotal} | ${lowClusterRate}% |`
    );
    lines.push('');

    // Top authors table
    lines.push('### Top Authors by Likes');
    lines.push('');
    lines.push(
      '| Author | Likes | Clustered | Noise | Cluster Rate | Top Cluster |'
    );
    lines.push(
      '|--------|-------|-----------|-------|--------------|-------------|'
    );

    for (const author of authorAnalysis.allAuthors.slice(0, 30)) {
      const clusterRate =
        author.totalLikes > 0
          ? ((author.clusteredLikes / author.totalLikes) * 100).toFixed(0)
          : '0';
      const topCluster =
        author.topCluster !== null ? `#${author.topCluster}` : '-';
      lines.push(
        `| @${author.handle} | ${author.totalLikes} | ${author.clusteredLikes} | ${author.noiseLikes} | ${clusterRate}% | ${topCluster} |`
      );
    }

    if (authorAnalysis.allAuthors.length > 30) {
      lines.push('');
      lines.push(
        `*...and ${authorAnalysis.allAuthors.length - 30} more authors*`
      );
    }
  }

  return lines.join('\n');
}

async function main() {
  const { days, minClusterSize, minSamples, dimensions, noCache } = parseArgs();

  // Check for required environment variables
  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required');
    console.error('Set it in your .env file or environment');
    process.exit(1);
  }

  if (!process.env.BLUESKY_AUTH_HANDLE || !process.env.BLUESKY_AUTH_PASSWORD) {
    console.error(
      'Error: BLUESKY_AUTH_HANDLE and BLUESKY_AUTH_PASSWORD are required'
    );
    console.error('Set them in your .env file to authenticate with Bluesky');
    process.exit(1);
  }

  const handle = process.env.BLUESKY_AUTH_HANDLE;
  const timestamp = new Date().toISOString().split('T')[0];
  const safeHandle = handle.replace(/\./g, '_');
  const outputPath = `output/likes-${safeHandle}-${timestamp}-dim${dimensions}-min${minClusterSize}-samples${minSamples}.md`;
  const cachePaths = getCachePaths(handle, days);

  console.log(`\n=== Likes Explorer ===`);
  console.log(`Handle: @${handle}`);
  console.log(`Days: ${days}`);
  console.log(`Dimensions: ${dimensions}`);
  console.log(`Min cluster size: ${minClusterSize}`);
  console.log(`Min samples: ${minSamples}`);
  console.log(`Cache: ${noCache ? 'disabled' : 'enabled'}`);
  console.log('');

  // Initialize clients
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  const openai = new OpenAI();

  // Step 1: Get likes (from cache or API)
  let likes: LikedPost[];
  const cachedLikes = noCache ? null : loadLikesCache(cachePaths.likes);

  if (cachedLikes) {
    likes = cachedLikes;
  } else {
    // Authenticate with Bluesky (required for getActorLikes)
    console.log('Authenticating with Bluesky...');
    await agent.login({
      identifier: handle,
      password: process.env.BLUESKY_AUTH_PASSWORD,
    });
    console.log('  Authenticated\n');

    likes = await fetchLikes(agent, handle, days);
    saveLikesCache(cachePaths.likes, likes);
  }

  if (likes.length < minClusterSize * 2) {
    console.error(
      `\nNot enough likes (${likes.length}) for meaningful clustering.`
    );
    console.error(
      `Need at least ${minClusterSize * 2} posts for minClusterSize=${minClusterSize}`
    );
    process.exit(1);
  }

  // Step 2: Get embeddings (from cache or API)
  let embeddings: number[][];
  const cachedEmbeddings = noCache
    ? null
    : loadEmbeddingsCache(cachePaths.embeddings);

  if (cachedEmbeddings) {
    // Slice to target dimensions if needed (cache stores at 1536)
    embeddings = sliceEmbeddings(cachedEmbeddings, dimensions);
  } else {
    // Generate at full dimensions for caching
    embeddings = await generateEmbeddings(openai, likes, FULL_EMBEDDING_DIMS);
    saveEmbeddingsCache(cachePaths.embeddings, embeddings, FULL_EMBEDDING_DIMS);

    // Slice to target dimensions if needed
    embeddings = sliceEmbeddings(embeddings, dimensions);
  }

  // Step 3: Cluster
  const { clusters, noise, noiseEmbeddings, labels } = clusterPosts(
    likes,
    embeddings,
    minClusterSize,
    minSamples
  );

  // Step 4: Analyze noise
  const noiseAnalysis =
    noise.length > 0
      ? analyzeNoise(noise, noiseEmbeddings, clusters, minClusterSize)
      : null;

  // Step 5: Analyze authors
  const authorAnalysis = analyzeAuthors(likes, labels);

  // Step 6: Generate report
  const report = generateReport(
    handle,
    days,
    likes.length,
    clusters,
    noise,
    noiseAnalysis,
    authorAnalysis,
    {
      dimensions,
      minClusterSize,
      minSamples,
    }
  );

  // Step 7: Write output
  const outputDir = outputPath.substring(0, outputPath.lastIndexOf('/'));
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, report);
  console.log(`\nReport written to: ${outputPath}`);

  // Print summary to console
  console.log(`\n=== Summary ===`);
  console.log(`Total likes: ${likes.length}`);
  console.log(`Clusters: ${clusters.length}`);
  for (const c of clusters) {
    console.log(`  Cluster ${c.clusterId}: ${c.size} posts`);
  }
  console.log(`Noise: ${noise.length} posts`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
