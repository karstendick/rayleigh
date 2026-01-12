-- Migration: Update vector dimensions from 512 to 1536
-- Embeddings are derived data and can be regenerated from OpenAI

-- Truncate tables with old embeddings (they'll be regenerated)
TRUNCATE post_embeddings;
TRUNCATE user_interest_clusters;

-- Update post_embeddings to 1536 dimensions
ALTER TABLE post_embeddings ALTER COLUMN embedding TYPE vector(1536);

-- Update user_interest_clusters to 1536 dimensions
ALTER TABLE user_interest_clusters ALTER COLUMN centroid TYPE vector(1536);

-- Add new table for user liked post embeddings
CREATE TABLE IF NOT EXISTS user_liked_post_embeddings (
  user_did TEXT NOT NULL,
  uri TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_did, uri)
);

CREATE INDEX IF NOT EXISTS idx_liked_post_embeddings_user ON user_liked_post_embeddings(user_did);
