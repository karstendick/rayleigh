import { setTimeout as sleep } from 'node:timers/promises';
import { AtpAgent } from '@atproto/api';
import { config } from '../config.js';
import {
  getLikedAuthors,
  getUserPreferences,
  setInterestClusters,
  setLikedAuthors,
  upsertUserPreferences,
} from '../db.js';
import { generateEmbeddings } from '../scoring/embeddings.js';
import { type ClusteringInput, clusterPosts } from './clustering.js';

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

  // Re-cluster if we have significant new likes
  const shouldRecluster = forceRecluster || newLikes.length > 100;

  if (shouldRecluster) {
    console.log(`Re-clustering with ${newLikes.length} new likes...`);

    // Generate embeddings for new likes
    const texts = newLikes.map((l) => l.text);
    const embeddings = await generateEmbeddings(texts);

    const clusteringInput: ClusteringInput[] = newLikes.map((like, i) => ({
      uri: like.uri,
      embedding: embeddings[i],
    }));

    const clusters = await clusterPosts(clusteringInput, 5, 1);

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
