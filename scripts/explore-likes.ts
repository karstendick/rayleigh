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
  exemplars: {
    post: LikedPost;
    probability: number;
  }[];
  samples: LikedPost[];
}

// Parse command line arguments
function parseArgs(): {
  days: number;
  minClusterSize: number;
  minSamples: number;
  dimensions: number;
} {
  const args = process.argv.slice(2);
  let days = 365;
  let minClusterSize = 5;
  let minSamples = 1;
  let dimensions = 1536;

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
    }
  }

  return { days, minClusterSize, minSamples, dimensions };
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

  for (let i = 0; i < posts.length; i++) {
    const label = labels[i];
    const prob = probabilities[i];

    if (label === -1) {
      noise.push(posts[i]);
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

  // Build cluster reports with exemplars
  const clusters: ClusterReport[] = [];

  for (const [clusterId, members] of clusterMap.entries()) {
    // Sort by probability (highest = most central)
    members.sort((a, b) => b.probability - a.probability);

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
      exemplars,
      samples,
    });
  }

  // Sort clusters by size (largest first)
  clusters.sort((a, b) => b.size - a.size);

  console.log(
    `  Found ${clusters.length} clusters, ${noise.length} noise posts`
  );

  return { clusters, noise };
}

// Generate markdown report
function generateReport(
  handle: string,
  days: number,
  totalLikes: number,
  clusters: ClusterReport[],
  noise: LikedPost[],
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

  // Noise section
  if (noise.length > 0) {
    lines.push('## Noise (unclustered posts)');
    lines.push('');
    lines.push(
      "These posts didn't fit into any cluster - they may represent one-off interests or outliers."
    );
    lines.push('');

    const noiseSample = noise.slice(0, 20);
    for (const post of noiseSample) {
      const preview = post.text.slice(0, 100).replace(/\n/g, ' ');
      lines.push(
        `- [@${post.authorHandle}](${postUrl(post)}): ${preview}${post.text.length > 100 ? '...' : ''}`
      );
    }

    if (noise.length > 20) {
      lines.push('');
      lines.push(`*...and ${noise.length - 20} more unclustered posts*`);
    }
  }

  return lines.join('\n');
}

async function main() {
  const { days, minClusterSize, minSamples, dimensions } = parseArgs();

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

  console.log(`\n=== Likes Explorer ===`);
  console.log(`Handle: @${handle}`);
  console.log(`Days: ${days}`);
  console.log(`Dimensions: ${dimensions}`);
  console.log(`Min cluster size: ${minClusterSize}`);
  console.log(`Min samples: ${minSamples}`);
  console.log('');

  // Initialize clients
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  const openai = new OpenAI();

  // Authenticate with Bluesky (required for getActorLikes)
  console.log('Authenticating with Bluesky...');
  await agent.login({
    identifier: handle,
    password: process.env.BLUESKY_AUTH_PASSWORD,
  });
  console.log('  Authenticated\n');

  // Step 1: Fetch likes
  const likes = await fetchLikes(agent, handle, days);

  if (likes.length < minClusterSize * 2) {
    console.error(
      `\nNot enough likes (${likes.length}) for meaningful clustering.`
    );
    console.error(
      `Need at least ${minClusterSize * 2} posts for minClusterSize=${minClusterSize}`
    );
    process.exit(1);
  }

  // Step 2: Generate embeddings
  const embeddings = await generateEmbeddings(openai, likes, dimensions);

  // Step 3: Cluster
  const { clusters, noise } = clusterPosts(
    likes,
    embeddings,
    minClusterSize,
    minSamples
  );

  // Step 4: Generate report
  const report = generateReport(handle, days, likes.length, clusters, noise, {
    dimensions,
    minClusterSize,
    minSamples,
  });

  // Step 5: Write output
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
