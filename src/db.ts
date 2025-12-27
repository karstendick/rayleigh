import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

// Initialize database schema
export async function initializeDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS posts (
        uri TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        author_did TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        indexed_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_posts_created_at
        ON posts(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_posts_indexed_at
        ON posts(indexed_at DESC);
    `);
    console.log('Database schema initialized');
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

// Graceful shutdown
export async function closeDatabase(): Promise<void> {
  await pool.end();
  console.log('Database connection closed');
}
