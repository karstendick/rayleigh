import { config } from '../config.js';
import {
  getInterestClusters,
  getLikedAuthors,
  getWhitelistedUserDids,
  pool,
  upsertScoredPost,
} from '../db.js';
import { scorePost, type UserSignals } from './scorer.js';

// Cache user signals to avoid repeated DB queries
// TTL is slightly shorter than preference refresh interval to ensure fresh data after updates
const signalsCache = new Map<
  string,
  { signals: UserSignals; cachedAt: number }
>();
const SIGNALS_CACHE_TTL = Math.max(
  config.preferencesRefreshIntervalMs - 5 * 60 * 1000, // 5 min before refresh
  5 * 60 * 1000 // minimum 5 minutes
);

/**
 * Get user signals, with caching
 */
async function getUserSignals(userDid: string): Promise<UserSignals | null> {
  const now = Date.now();
  const cached = signalsCache.get(userDid);

  if (cached && now - cached.cachedAt < SIGNALS_CACHE_TTL) {
    return cached.signals;
  }

  // Load from database
  const [likedAuthorsMap, clustersData] = await Promise.all([
    getLikedAuthors(userDid),
    getInterestClusters(userDid),
  ]);

  if (likedAuthorsMap.size === 0 && clustersData.length === 0) {
    return null;
  }

  const signals: UserSignals = {
    likedAuthors: new Set(likedAuthorsMap.keys()),
    clusters: clustersData.map((c) => ({
      clusterId: c.clusterId,
      centroid: c.centroid,
    })),
  };

  signalsCache.set(userDid, { signals, cachedAt: now });
  return signals;
}

/**
 * Clear the signals cache (call when preferences are updated)
 */
export function clearSignalsCache(userDid?: string): void {
  if (userDid) {
    signalsCache.delete(userDid);
  } else {
    signalsCache.clear();
  }
}

/**
 * Score recent posts for all whitelisted users
 *
 * This function:
 * 1. Gets all posts with embeddings from the last scoring interval
 * 2. For each whitelisted user, scores the posts
 * 3. Stores scores in the scored_posts table
 */
export async function scoreRecentPosts(): Promise<{
  postsScored: number;
  usersProcessed: number;
}> {
  // Get whitelisted user DIDs
  const userDids = await getWhitelistedUserDids();

  if (userDids.length === 0) {
    return { postsScored: 0, usersProcessed: 0 };
  }

  // Get posts with embeddings that haven't been scored recently
  // We look at posts from the last 2 hours to catch up on any missed scoring
  const result = await pool.query(`
    SELECT p.uri, p.author_did as "authorDid", pe.embedding::text
    FROM posts p
    JOIN post_embeddings pe ON p.uri = pe.uri
    WHERE p.indexed_at > NOW() - INTERVAL '2 hours'
    ORDER BY p.indexed_at DESC
    LIMIT 1000
  `);

  const posts = result.rows.map((row) => ({
    uri: row.uri,
    authorDid: row.authorDid,
    embedding: JSON.parse(row.embedding) as number[],
  }));

  if (posts.length === 0) {
    return { postsScored: 0, usersProcessed: userDids.length };
  }

  let totalScored = 0;

  for (const userDid of userDids) {
    const signals = await getUserSignals(userDid);
    if (!signals) continue;

    for (const post of posts) {
      const result = scorePost(post.authorDid, post.embedding, signals);

      // Only store posts with non-zero scores to save space
      if (result.score > 0) {
        await upsertScoredPost({
          userDid,
          postUri: post.uri,
          score: result.score,
          authorScore: result.authorScore,
          topicScore: result.topicScore,
          matchedClusterId: result.matchedClusterId,
        });
        totalScored++;
      }
    }
  }

  return { postsScored: totalScored, usersProcessed: userDids.length };
}

// Worker state
let scoringInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background scoring worker
 */
export function startScoringWorker(): void {
  if (scoringInterval) {
    console.log('Scoring worker already running');
    return;
  }

  console.log(
    `Starting scoring worker (interval: ${config.scoringIntervalMs}ms)`
  );

  // Run immediately on start
  scoreRecentPosts()
    .then(({ postsScored, usersProcessed }) => {
      console.log(
        `Initial scoring: ${postsScored} posts scored for ${usersProcessed} users`
      );
    })
    .catch((err) => {
      console.error('Error in initial scoring:', err);
    });

  // Then run on interval
  scoringInterval = setInterval(() => {
    scoreRecentPosts()
      .then(({ postsScored, usersProcessed }) => {
        if (postsScored > 0) {
          console.log(
            `Scoring: ${postsScored} posts scored for ${usersProcessed} users`
          );
        }
      })
      .catch((err) => {
        console.error('Error in scoring worker:', err);
      });
  }, config.scoringIntervalMs);
}

/**
 * Stop the background scoring worker
 */
export function stopScoringWorker(): void {
  if (scoringInterval) {
    clearInterval(scoringInterval);
    scoringInterval = null;
    console.log('Scoring worker stopped');
  }
}
