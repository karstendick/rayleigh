import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

// Verify database migrations have been run
// NOTE: Run `pnpm migrate` before starting the app
// NOTE: pgvector extension must be enabled manually in Fly.io dashboard
export async function initializeDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    // Check that migrations table exists and has been populated
    const result = await client.query(`
      SELECT COUNT(*) as count FROM pgmigrations
    `);
    const migrationCount = parseInt(result.rows[0].count, 10);

    if (migrationCount === 0) {
      throw new Error(
        'No migrations have been run. Please run `pnpm migrate` first.'
      );
    }

    console.log(`Database ready (${migrationCount} migrations applied)`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('relation "pgmigrations" does not exist')
    ) {
      throw new Error(
        'Database not initialized. Please run `pnpm migrate` first.'
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

// Insert a post
export async function insertPost(post: {
  uri: string;
  cid: string;
  authorDid: string;
  text: string;
  createdAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO posts (uri, cid, author_did, text, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (uri) DO NOTHING`,
    [post.uri, post.cid, post.authorDid, post.text, post.createdAt]
  );
}

// Get recent posts for feed (chronological)
export async function getRecentPosts(
  limit: number,
  cursor?: string
): Promise<{ uri: string; cid: string; indexedAt: Date }[]> {
  let query = `
    SELECT uri, cid, indexed_at as "indexedAt"
    FROM posts
  `;
  const params: (number | Date)[] = [];

  if (cursor) {
    // Cursor is a timestamp in milliseconds
    const cursorDate = new Date(parseInt(cursor, 10));
    query += ` WHERE indexed_at < $1`;
    params.push(cursorDate);
  }

  query += ` ORDER BY indexed_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await pool.query(query, params);
  return result.rows;
}

// Delete old posts (older than 48 hours)
export async function cleanupOldPosts(): Promise<number> {
  const result = await pool.query(`
    DELETE FROM posts
    WHERE created_at < NOW() - INTERVAL '48 hours'
  `);
  return result.rowCount ?? 0;
}

// Get post count (for monitoring)
export async function getPostCount(): Promise<number> {
  const result = await pool.query('SELECT COUNT(*) as count FROM posts');
  return parseInt(result.rows[0].count, 10);
}

// Get embedding count (for monitoring)
export async function getEmbeddingCount(): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM post_embeddings'
  );
  return parseInt(result.rows[0].count, 10);
}

// Get scoring stats (for monitoring)
export async function getScoringStats(): Promise<{
  users: { userDid: string; userHandle: string; scoredPosts: number }[];
  totalScoredPosts: number;
}> {
  const result = await pool.query(`
    SELECT up.user_did as "userDid", up.user_handle as "userHandle",
           COUNT(sp.post_uri) as "scoredPosts"
    FROM user_preferences up
    LEFT JOIN scored_posts sp ON up.user_did = sp.user_did
    GROUP BY up.user_did, up.user_handle
  `);

  const users = result.rows.map((row) => ({
    userDid: row.userDid,
    userHandle: row.userHandle,
    scoredPosts: parseInt(row.scoredPosts, 10),
  }));

  const totalScoredPosts = users.reduce((sum, u) => sum + u.scoredPosts, 0);

  return { users, totalScoredPosts };
}

// ============ Post Embeddings ============

// Insert post embedding
export async function insertPostEmbedding(
  uri: string,
  embedding: number[]
): Promise<void> {
  const embeddingStr = `[${embedding.join(',')}]`;
  await pool.query(
    `INSERT INTO post_embeddings (uri, embedding)
     VALUES ($1, $2)
     ON CONFLICT (uri) DO UPDATE SET embedding = $2`,
    [uri, embeddingStr]
  );
}

// Batch insert post embeddings (much more efficient than individual inserts)
export async function insertPostEmbeddingsBatch(
  items: { uri: string; embedding: number[] }[]
): Promise<void> {
  if (items.length === 0) return;

  // Use UNNEST to insert multiple rows from arrays (fully parameterized)
  const uris = items.map((i) => i.uri);
  const embeddings = items.map((i) => `[${i.embedding.join(',')}]`);

  await pool.query(
    `INSERT INTO post_embeddings (uri, embedding)
     SELECT * FROM UNNEST($1::text[], $2::vector[])
     ON CONFLICT (uri) DO UPDATE SET embedding = EXCLUDED.embedding`,
    [uris, embeddings]
  );
}

// Get posts without embeddings
export async function getPostsWithoutEmbeddings(
  limit: number
): Promise<{ uri: string; text: string }[]> {
  const result = await pool.query(
    `SELECT p.uri, p.text
     FROM posts p
     LEFT JOIN post_embeddings pe ON p.uri = pe.uri
     WHERE pe.uri IS NULL
     ORDER BY p.indexed_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// Get post embedding
export async function getPostEmbedding(uri: string): Promise<number[] | null> {
  const result = await pool.query(
    `SELECT embedding::text FROM post_embeddings WHERE uri = $1`,
    [uri]
  );
  if (result.rows.length === 0) return null;
  // Parse the vector string [x,y,z,...] to number array
  const embStr = result.rows[0].embedding;
  return JSON.parse(embStr);
}

// Get post embeddings for multiple URIs (batch lookup)
export async function getPostEmbeddingsBatch(
  uris: string[]
): Promise<Map<string, number[]>> {
  if (uris.length === 0) return new Map();

  const result = await pool.query(
    `SELECT uri, embedding::text FROM post_embeddings WHERE uri = ANY($1)`,
    [uris]
  );

  const embeddings = new Map<string, number[]>();
  for (const row of result.rows) {
    embeddings.set(row.uri, JSON.parse(row.embedding));
  }
  return embeddings;
}

// ============ User Preferences ============

// Get user preferences
export async function getUserPreferences(userDid: string): Promise<{
  userDid: string;
  userHandle: string;
  lastLikesSync: Date | null;
  lastClustering: Date | null;
  likesCursor: string | null;
} | null> {
  const result = await pool.query(
    `SELECT user_did as "userDid", user_handle as "userHandle",
            last_likes_sync as "lastLikesSync", last_clustering as "lastClustering",
            likes_cursor as "likesCursor"
     FROM user_preferences WHERE user_did = $1`,
    [userDid]
  );
  return result.rows[0] || null;
}

// Upsert user preferences
export async function upsertUserPreferences(prefs: {
  userDid: string;
  userHandle: string;
  lastLikesSync?: Date;
  lastClustering?: Date;
  likesCursor?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO user_preferences (user_did, user_handle, last_likes_sync, last_clustering, likes_cursor)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_did) DO UPDATE SET
       user_handle = $2,
       last_likes_sync = COALESCE($3, user_preferences.last_likes_sync),
       last_clustering = COALESCE($4, user_preferences.last_clustering),
       likes_cursor = COALESCE($5, user_preferences.likes_cursor)`,
    [
      prefs.userDid,
      prefs.userHandle,
      prefs.lastLikesSync || null,
      prefs.lastClustering || null,
      prefs.likesCursor || null,
    ]
  );
}

// ============ Liked Authors ============

// Get liked author count for a user (lightweight for health checks)
export async function getLikedAuthorCount(userDid: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM user_liked_authors WHERE user_did = $1`,
    [userDid]
  );
  return parseInt(result.rows[0].count, 10);
}

// Get liked authors for a user
export async function getLikedAuthors(
  userDid: string
): Promise<Map<string, number>> {
  const result = await pool.query(
    `SELECT author_did, like_count FROM user_liked_authors WHERE user_did = $1`,
    [userDid]
  );
  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(row.author_did, row.like_count);
  }
  return map;
}

// Set liked authors for a user (replaces all)
export async function setLikedAuthors(
  userDid: string,
  authors: Map<string, number>
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_liked_authors WHERE user_did = $1', [
      userDid,
    ]);
    for (const [authorDid, likeCount] of authors) {
      await client.query(
        `INSERT INTO user_liked_authors (user_did, author_did, like_count)
         VALUES ($1, $2, $3)`,
        [userDid, authorDid, likeCount]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ============ Liked Post Embeddings ============

// Get all liked post embeddings for a user
export async function getUserLikedPostEmbeddings(
  userDid: string
): Promise<Map<string, number[]>> {
  const result = await pool.query(
    `SELECT uri, embedding::text FROM user_liked_post_embeddings WHERE user_did = $1`,
    [userDid]
  );
  const map = new Map<string, number[]>();
  for (const row of result.rows) {
    map.set(row.uri, JSON.parse(row.embedding));
  }
  return map;
}

// Insert liked post embeddings (batch)
export async function insertUserLikedPostEmbeddings(
  userDid: string,
  items: { uri: string; embedding: number[] }[]
): Promise<void> {
  if (items.length === 0) return;

  // Use UNNEST to insert multiple rows efficiently
  const uris = items.map((i) => i.uri);
  const embeddings = items.map((i) => `[${i.embedding.join(',')}]`);
  const userDids = items.map(() => userDid);

  await pool.query(
    `INSERT INTO user_liked_post_embeddings (user_did, uri, embedding)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::vector[])
     ON CONFLICT (user_did, uri) DO UPDATE SET embedding = EXCLUDED.embedding`,
    [userDids, uris, embeddings]
  );
}

// Get count of liked post embeddings for a user
export async function getUserLikedPostEmbeddingCount(
  userDid: string
): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM user_liked_post_embeddings WHERE user_did = $1`,
    [userDid]
  );
  return parseInt(result.rows[0].count, 10);
}

// ============ Interest Clusters ============

// Get cluster count for a user (lightweight for health checks)
export async function getClusterCount(userDid: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM user_interest_clusters WHERE user_did = $1`,
    [userDid]
  );
  return parseInt(result.rows[0].count, 10);
}

// Get interest clusters for a user
export async function getInterestClusters(
  userDid: string
): Promise<
  { clusterId: number; centroid: number[]; exemplarUris: string[] }[]
> {
  const result = await pool.query(
    `SELECT cluster_id as "clusterId", centroid::text, exemplar_uris as "exemplarUris"
     FROM user_interest_clusters WHERE user_did = $1`,
    [userDid]
  );
  return result.rows.map((row) => ({
    clusterId: row.clusterId,
    centroid: JSON.parse(row.centroid),
    exemplarUris: row.exemplarUris || [],
  }));
}

// Set interest clusters for a user (replaces all)
export async function setInterestClusters(
  userDid: string,
  clusters: { clusterId: number; centroid: number[]; exemplarUris: string[] }[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM user_interest_clusters WHERE user_did = $1',
      [userDid]
    );
    for (const cluster of clusters) {
      const centroidStr = `[${cluster.centroid.join(',')}]`;
      await client.query(
        `INSERT INTO user_interest_clusters (user_did, cluster_id, centroid, exemplar_uris)
         VALUES ($1, $2, $3, $4)`,
        [userDid, cluster.clusterId, centroidStr, cluster.exemplarUris]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ============ Scored Posts ============

// Get scored posts for a user (for feed)
export async function getScoredPosts(
  userDid: string,
  limit: number,
  cursor?: string
): Promise<
  {
    uri: string;
    cid: string;
    score: number;
    authorScore: number;
    topicScore: number;
    matchedClusterId: number | null;
    scoredAt: Date;
  }[]
> {
  let query = `
    SELECT sp.post_uri as uri, p.cid, sp.score, sp.author_score as "authorScore",
           sp.topic_score as "topicScore", sp.matched_cluster_id as "matchedClusterId",
           sp.scored_at as "scoredAt"
    FROM scored_posts sp
    JOIN posts p ON sp.post_uri = p.uri
    WHERE sp.user_did = $1
  `;
  const params: (string | number | Date)[] = [userDid];

  if (cursor) {
    // Cursor format: "score:timestamp"
    const [scoreStr, timestampStr] = cursor.split(':');
    const cursorScore = parseFloat(scoreStr);
    const cursorTime = new Date(parseInt(timestampStr, 10));
    query += ` AND (sp.score < $2 OR (sp.score = $2 AND sp.scored_at < $3))`;
    params.push(cursorScore, cursorTime);
  }

  query += ` ORDER BY sp.score DESC, sp.scored_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await pool.query(query, params);
  return result.rows;
}

// Insert or update scored post
export async function upsertScoredPost(scored: {
  userDid: string;
  postUri: string;
  score: number;
  authorScore: number;
  topicScore: number;
  matchedClusterId: number | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO scored_posts (user_did, post_uri, score, author_score, topic_score, matched_cluster_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_did, post_uri) DO UPDATE SET
       score = $3, author_score = $4, topic_score = $5, matched_cluster_id = $6, scored_at = NOW()`,
    [
      scored.userDid,
      scored.postUri,
      scored.score,
      scored.authorScore,
      scored.topicScore,
      scored.matchedClusterId,
    ]
  );
}

// Clean up old scored posts
export async function cleanupOldScoredPosts(): Promise<number> {
  const result = await pool.query(`
    DELETE FROM scored_posts
    WHERE scored_at < NOW() - INTERVAL '48 hours'
  `);
  return result.rowCount ?? 0;
}

// Get all whitelisted user DIDs
export async function getWhitelistedUserDids(): Promise<string[]> {
  const result = await pool.query(`SELECT user_did FROM user_preferences`);
  return result.rows.map((row) => row.user_did);
}

// ============ Shutdown ============

// Graceful shutdown
export async function closeDatabase(): Promise<void> {
  await pool.end();
  console.log('Database connection closed');
}
