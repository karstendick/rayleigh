-- Baseline migration: captures existing schema
-- For existing databases, mark this as already run:
--   INSERT INTO pgmigrations (name, run_on) VALUES ('001_initial_schema', NOW());

-- Posts table
CREATE TABLE IF NOT EXISTS posts (
  uri TEXT PRIMARY KEY,
  cid TEXT NOT NULL,
  author_did TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  indexed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_indexed_at ON posts(indexed_at DESC);

-- Post embeddings (512 dimensions - original)
CREATE TABLE IF NOT EXISTS post_embeddings (
  uri TEXT PRIMARY KEY REFERENCES posts(uri) ON DELETE CASCADE,
  embedding vector(512) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- User preferences metadata
CREATE TABLE IF NOT EXISTS user_preferences (
  user_did TEXT PRIMARY KEY,
  user_handle TEXT NOT NULL,
  last_likes_sync TIMESTAMPTZ,
  last_clustering TIMESTAMPTZ,
  likes_cursor TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Liked authors (author signal)
CREATE TABLE IF NOT EXISTS user_liked_authors (
  user_did TEXT NOT NULL,
  author_did TEXT NOT NULL,
  like_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_did, author_did)
);

CREATE INDEX IF NOT EXISTS idx_liked_authors_user ON user_liked_authors(user_did);

-- Interest clusters (512 dimensions - original)
CREATE TABLE IF NOT EXISTS user_interest_clusters (
  user_did TEXT NOT NULL,
  cluster_id INTEGER NOT NULL,
  centroid vector(512) NOT NULL,
  exemplar_uris TEXT[],
  PRIMARY KEY (user_did, cluster_id)
);

CREATE INDEX IF NOT EXISTS idx_interest_clusters_user ON user_interest_clusters(user_did);

-- Cached scores for feed serving
CREATE TABLE IF NOT EXISTS scored_posts (
  user_did TEXT NOT NULL,
  post_uri TEXT NOT NULL,
  score REAL NOT NULL,
  author_score REAL NOT NULL,
  topic_score REAL NOT NULL,
  matched_cluster_id INTEGER,
  scored_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_did, post_uri)
);

CREATE INDEX IF NOT EXISTS idx_scored_posts_user_score ON scored_posts(user_did, score DESC);
CREATE INDEX IF NOT EXISTS idx_scored_posts_scored_at ON scored_posts(scored_at);
