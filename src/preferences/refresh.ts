import { setTimeout as sleep } from 'node:timers/promises';
import { AtpAgent } from '@atproto/api';
import { config } from '../config.js';
import {
  getLikedAuthors,
  getUserLikedPostEmbeddings,
  getUserPreferences,
  insertUserLikedPostEmbeddings,
  setInterestClusters,
  setLikedAuthors,
  upsertUserPreferences,
} from '../db.js';
import { generateEmbeddings } from '../scoring/embeddings.js';
import {
  type ClusteringInput,
  clusterWithBirch,
  incrementalUpdate,
} from './birchClustering.js';

interface LikedPost {
  uri: string;
  text: string;
  authorDid: string;
}

/**
 * Fetch new likes since the last sync
 */
async function fetchNewLikes(
  agent: AtpAgent,
  handle: string,
  sinceCursor?: string
): Promise<{ likes: LikedPost[]; cursor: string | undefined }> {
  const likes: LikedPost[] = [];
  let currentCursor: string | undefined;
  let page = 0;

  console.log(`Fetching new likes for @${handle}...`);

  while (true) {
    page++;
    const response = await agent.app.bsky.feed.getActorLikes({
      actor: handle,
      limit: 100,
      cursor: currentCursor,
    });

    const feed = response.data.feed;
    if (feed.length === 0) break;

    // Check if we've reached the cursor from last sync
    let reachedOldCursor = false;

    for (const item of feed) {
      const post = item.post;
      const record = post.record as { text?: string };

      // Skip posts without text
      if (!record.text) continue;

      likes.push({
        uri: post.uri,
        text: record.text,
        authorDid: post.author.did,
      });
    }

    // On first page, save the new cursor
    if (page === 1) {
      currentCursor = response.data.cursor;
    }

    // Check if we've gone past the old cursor (by comparing URIs)
    // The API returns likes in reverse chronological order
    if (sinceCursor && response.data.cursor === sinceCursor) {
      reachedOldCursor = true;
    }

    if (reachedOldCursor) break;
    if (!response.data.cursor) break;

    // Rate limiting
    await sleep(100);

    // Safety limit: don't fetch more than 50 pages of new likes
    if (page >= 50) {
      console.log('  Reached page limit, stopping fetch');
      break;
    }
  }

  console.log(`  Found ${likes.length} new likes`);
  return { likes, cursor: currentCursor };
}

/**
 * Refresh user preferences with new likes
 *
 * This function:
 * 1. Fetches new likes since last sync
 * 2. Updates author like counts
 * 3. Re-clusters if there are significant new likes (>100)
 *
 * @param userDid - The user's DID
 * @param forceRecluster - Force re-clustering even with few new likes
 */
export async function refreshUserPreferences(
  userDid: string,
  forceRecluster = false
): Promise<void> {
  // Get existing preferences
  const prefs = await getUserPreferences(userDid);
  if (!prefs) {
    console.log(`No preferences found for ${userDid}, skipping refresh`);
    return;
  }

  console.log(`\n=== Refreshing preferences for @${prefs.userHandle} ===`);

  // Check for required credentials
  if (!config.blueskyAuthHandle || !config.blueskyAuthPassword) {
    throw new Error(
      'BLUESKY_AUTH_HANDLE and BLUESKY_AUTH_PASSWORD are required'
    );
  }

  // Authenticate
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  await agent.login({
    identifier: config.blueskyAuthHandle,
    password: config.blueskyAuthPassword,
  });

  // Fetch new likes
  const { likes: newLikes, cursor: newCursor } = await fetchNewLikes(
    agent,
    prefs.userHandle,
    prefs.likesCursor || undefined
  );

  if (newLikes.length === 0) {
    console.log('No new likes found');
    return;
  }

  // Update author counts
  const existingAuthors = await getLikedAuthors(userDid);
  console.log(`Updating author counts (${existingAuthors.size} existing)...`);

  for (const like of newLikes) {
    const count = existingAuthors.get(like.authorDid) || 0;
    existingAuthors.set(like.authorDid, count + 1);
  }

  // Filter to authors with 2+ likes
  const significantAuthors = new Map<string, number>();
  for (const [authorDid, count] of existingAuthors) {
    if (count >= 2) {
      significantAuthors.set(authorDid, count);
    }
  }

  await setLikedAuthors(userDid, significantAuthors);
  console.log(`  Updated to ${significantAuthors.size} significant authors`);

  // Re-cluster if we have significant new likes or forced
  const shouldRecluster = forceRecluster || newLikes.length > 100;

  if (shouldRecluster) {
    console.log(`Re-clustering with ${newLikes.length} new likes...`);

    // Fetch all existing liked post embeddings for this user
    const existingEmbeddings = await getUserLikedPostEmbeddings(userDid);
    const isFirstClustering = existingEmbeddings.size === 0;

    // Find new likes that need embeddings generated
    const postsNeedingEmbeddings = newLikes.filter(
      (l) => !existingEmbeddings.has(l.uri)
    );

    console.log(
      `  Found ${existingEmbeddings.size} existing embeddings, need ${postsNeedingEmbeddings.length} new`
    );

    // Generate embeddings for new posts in batches
    const newEmbeddingItems: { uri: string; embedding: number[] }[] = [];
    const EMBEDDING_BATCH_SIZE = 100;

    for (
      let i = 0;
      i < postsNeedingEmbeddings.length;
      i += EMBEDDING_BATCH_SIZE
    ) {
      const batch = postsNeedingEmbeddings.slice(i, i + EMBEDDING_BATCH_SIZE);
      const texts = batch.map((l) => l.text);
      const batchEmbeddings = await generateEmbeddings(texts);

      for (let j = 0; j < batch.length; j++) {
        const uri = batch[j].uri;
        const embedding = batchEmbeddings[j];
        existingEmbeddings.set(uri, embedding);
        newEmbeddingItems.push({ uri, embedding });
      }

      console.log(
        `  Generated embeddings: ${Math.min(i + EMBEDDING_BATCH_SIZE, postsNeedingEmbeddings.length)}/${postsNeedingEmbeddings.length}`
      );
    }

    // Store new embeddings in the database
    if (newEmbeddingItems.length > 0) {
      await insertUserLikedPostEmbeddings(userDid, newEmbeddingItems);
      console.log(`  Stored ${newEmbeddingItems.length} new embeddings`);
    }

    // Build clustering input from all embeddings
    const allClusteringInput: ClusteringInput[] = Array.from(
      existingEmbeddings.entries()
    ).map(([uri, embedding]) => ({ uri, embedding }));

    // Build input for just the new posts (for incremental update)
    const newClusteringInput: ClusteringInput[] = newEmbeddingItems.map(
      (item) => ({ uri: item.uri, embedding: item.embedding })
    );

    // Use BIRCH clustering
    let clusters: Awaited<ReturnType<typeof clusterWithBirch>>;
    if (isFirstClustering || newClusteringInput.length === 0) {
      // First time clustering or no new posts - do full clustering
      console.log(`  Performing full BIRCH clustering...`);
      clusters = await clusterWithBirch(allClusteringInput);
    } else {
      // Incremental update with new posts
      console.log(`  Performing incremental BIRCH update...`);
      clusters = await incrementalUpdate(
        newClusteringInput,
        allClusteringInput
      );
    }

    const clusterData = clusters.map((c) => ({
      clusterId: c.clusterId,
      centroid: c.centroid,
      exemplarUris: c.exemplarUris,
    }));

    await setInterestClusters(userDid, clusterData);
    console.log(`  Updated to ${clusters.length} clusters`);

    await upsertUserPreferences({
      userDid,
      userHandle: prefs.userHandle,
      lastLikesSync: new Date(),
      lastClustering: new Date(),
      likesCursor: newCursor,
    });
  } else {
    // Just update the sync time and cursor
    await upsertUserPreferences({
      userDid,
      userHandle: prefs.userHandle,
      lastLikesSync: new Date(),
      likesCursor: newCursor,
    });
  }

  console.log(`=== Refresh complete ===\n`);
}
