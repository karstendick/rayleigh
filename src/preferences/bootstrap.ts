import { setTimeout as sleep } from 'node:timers/promises';
import { AtpAgent } from '@atproto/api';
import { config } from '../config.js';
import {
  getUserLikedPostEmbeddings,
  insertUserLikedPostEmbeddings,
  setInterestClusters,
  setLikedAuthors,
  upsertUserPreferences,
} from '../db.js';
import { generateEmbeddings } from '../scoring/embeddings.js';
import { type ClusteringInput, clusterWithBirch } from './birchClustering.js';

interface LikedPost {
  uri: string;
  text: string;
  authorDid: string;
}

/**
 * Fetch likes for a user from Bluesky API
 *
 * @param agent - Authenticated ATP agent
 * @param handle - User handle to fetch likes for
 * @param days - Number of days of likes to fetch (default: 365)
 * @param cursor - Optional cursor to resume from
 * @returns Array of liked posts and the final cursor
 */
async function fetchLikes(
  agent: AtpAgent,
  handle: string,
  days = 365,
  cursor?: string
): Promise<{ likes: LikedPost[]; cursor: string | undefined }> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const likes: LikedPost[] = [];
  let currentCursor = cursor;
  let page = 0;

  console.log(`Fetching likes for @${handle} from the last ${days} days...`);

  while (true) {
    page++;
    const response = await agent.app.bsky.feed.getActorLikes({
      actor: handle,
      limit: 100,
      cursor: currentCursor,
    });

    const feed = response.data.feed;
    if (feed.length === 0) break;

    let reachedCutoff = false;
    for (const item of feed) {
      const post = item.post;
      const record = post.record as { text?: string; createdAt?: string };

      // Skip posts without text
      if (!record.text) continue;

      // Check date
      const createdAt = new Date(record.createdAt || post.indexedAt);
      if (createdAt < cutoffDate) {
        reachedCutoff = true;
        break;
      }

      likes.push({
        uri: post.uri,
        text: record.text,
        authorDid: post.author.did,
      });
    }

    if (reachedCutoff) break;

    currentCursor = response.data.cursor;
    if (!currentCursor) break;

    // Progress update
    if (page % 10 === 0) {
      console.log(`  Fetched ${likes.length} likes so far (page ${page})...`);
    }

    // Rate limiting
    await sleep(100);
  }

  console.log(`  Found ${likes.length} likes with text`);
  return { likes, cursor: currentCursor };
}

/**
 * Extract author like counts from liked posts
 * Returns authors with 2+ likes (the author signal threshold)
 */
function extractLikedAuthors(likes: LikedPost[]): Map<string, number> {
  const authorCounts = new Map<string, number>();

  for (const like of likes) {
    const count = authorCounts.get(like.authorDid) || 0;
    authorCounts.set(like.authorDid, count + 1);
  }

  // Filter to authors with 2+ likes
  const significantAuthors = new Map<string, number>();
  for (const [authorDid, count] of authorCounts) {
    if (count >= 2) {
      significantAuthors.set(authorDid, count);
    }
  }

  console.log(
    `  Found ${significantAuthors.size} authors with 2+ likes (out of ${authorCounts.size} total)`
  );
  return significantAuthors;
}

/**
 * Bootstrap user preferences from their Bluesky likes
 *
 * This function:
 * 1. Fetches the user's likes from Bluesky
 * 2. Generates embeddings for liked posts
 * 3. Clusters posts to find interest topics
 * 4. Extracts liked authors (with 2+ likes)
 * 5. Stores everything in the database
 *
 * @param userDid - The user's DID
 * @param userHandle - The user's handle
 * @param days - Number of days of likes to analyze (default: 365)
 */
export async function bootstrapUserPreferences(
  userDid: string,
  userHandle: string,
  days = 365
): Promise<void> {
  console.log(`\n=== Bootstrapping preferences for @${userHandle} ===`);

  // Check for required credentials
  if (!config.blueskyAuthHandle || !config.blueskyAuthPassword) {
    throw new Error(
      'BLUESKY_AUTH_HANDLE and BLUESKY_AUTH_PASSWORD are required for fetching likes'
    );
  }

  // Authenticate with Bluesky
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  console.log('Authenticating with Bluesky...');
  await agent.login({
    identifier: config.blueskyAuthHandle,
    password: config.blueskyAuthPassword,
  });

  // Fetch likes
  const { likes, cursor } = await fetchLikes(agent, userHandle, days);

  if (likes.length === 0) {
    console.log('No likes found, skipping preference bootstrap');
    return;
  }

  // Extract liked authors
  const likedAuthors = extractLikedAuthors(likes);

  console.log(`Processing embeddings for ${likes.length} posts...`);

  // Fetch any existing liked post embeddings for this user
  const existingEmbeddings = await getUserLikedPostEmbeddings(userDid);
  const postsNeedingEmbeddings = likes.filter(
    (l) => !existingEmbeddings.has(l.uri)
  );

  console.log(
    `  Found ${existingEmbeddings.size} existing embeddings, need ${postsNeedingEmbeddings.length} new`
  );

  // Generate embeddings for posts that don't have them
  const newEmbeddingItems: { uri: string; embedding: number[] }[] = [];
  const EMBEDDING_BATCH_SIZE = 100;

  for (
    let i = 0;
    i < postsNeedingEmbeddings.length;
    i += EMBEDDING_BATCH_SIZE
  ) {
    const batch = postsNeedingEmbeddings.slice(i, i + EMBEDDING_BATCH_SIZE);
    const texts = batch.map((l) => l.text);
    console.log(
      `  Generating batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1}/${Math.ceil(postsNeedingEmbeddings.length / EMBEDDING_BATCH_SIZE)}...`
    );
    const batchEmbeddings = await generateEmbeddings(texts);
    for (let j = 0; j < batch.length; j++) {
      const uri = batch[j].uri;
      const embedding = batchEmbeddings[j];
      existingEmbeddings.set(uri, embedding);
      newEmbeddingItems.push({ uri, embedding });
    }
  }

  // Store new embeddings in the database
  if (newEmbeddingItems.length > 0) {
    await insertUserLikedPostEmbeddings(userDid, newEmbeddingItems);
    console.log(`  Stored ${newEmbeddingItems.length} embeddings`);
  }

  // Build clustering input from all embeddings
  const clusteringInput: ClusteringInput[] = Array.from(
    existingEmbeddings.entries()
  ).map(([uri, embedding]) => ({ uri, embedding }));

  // Cluster posts using BIRCH
  console.log('  Clustering with BIRCH...');
  const clusters = await clusterWithBirch(clusteringInput);

  // Store preferences in database
  console.log('Storing preferences in database...');

  // Store user preferences metadata
  await upsertUserPreferences({
    userDid,
    userHandle,
    lastLikesSync: new Date(),
    lastClustering: new Date(),
    likesCursor: cursor,
  });

  // Store liked authors
  await setLikedAuthors(userDid, likedAuthors);

  // Store interest clusters
  const clusterData = clusters.map((c) => ({
    clusterId: c.clusterId,
    centroid: c.centroid,
    exemplarUris: c.exemplarUris,
  }));
  await setInterestClusters(userDid, clusterData);

  console.log(
    `=== Bootstrap complete: ${likedAuthors.size} authors, ${clusters.length} clusters ===\n`
  );
}
