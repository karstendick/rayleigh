import { config } from '../config.js';
import { cosineSimilarity } from './embeddings.js';

export interface UserSignals {
  likedAuthors: Set<string>;
  clusters: { clusterId: number; centroid: number[] }[];
}

export interface ScoreResult {
  score: number;
  authorScore: number;
  topicScore: number;
  matchedClusterId: number | null;
}

/**
 * Calculate author score
 * Returns 1.0 if author is in liked authors set, 0.0 otherwise
 */
function calculateAuthorScore(
  authorDid: string,
  likedAuthors: Set<string>
): number {
  return likedAuthors.has(authorDid) ? 1.0 : 0.0;
}

/**
 * Calculate topic score
 * Returns max cosine similarity between post embedding and any cluster centroid
 */
function calculateTopicScore(
  embedding: number[],
  clusters: { clusterId: number; centroid: number[] }[]
): { score: number; matchedClusterId: number | null } {
  if (clusters.length === 0) {
    return { score: 0, matchedClusterId: null };
  }

  let maxSimilarity = 0;
  let matchedClusterId: number | null = null;

  for (const cluster of clusters) {
    const similarity = cosineSimilarity(embedding, cluster.centroid);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      matchedClusterId = cluster.clusterId;
    }
  }

  return { score: maxSimilarity, matchedClusterId };
}

/**
 * Calculate combined score for a post
 *
 * Formula: score = max(topicScore, authorScore) + bonusFactor * min(topicScore, authorScore)
 *
 * This gives weight to the stronger signal while still rewarding posts that match both signals.
 */
export function scorePost(
  authorDid: string,
  embedding: number[],
  signals: UserSignals
): ScoreResult {
  const authorScore = calculateAuthorScore(authorDid, signals.likedAuthors);
  const { score: topicScore, matchedClusterId } = calculateTopicScore(
    embedding,
    signals.clusters
  );

  // Combined score formula
  const maxScore = Math.max(topicScore, authorScore);
  const minScore = Math.min(topicScore, authorScore);
  const score = maxScore + config.scoringBonusFactor * minScore;

  return {
    score,
    authorScore,
    topicScore,
    matchedClusterId,
  };
}

/**
 * Score multiple posts for a user
 */
export function scorePosts(
  posts: { uri: string; authorDid: string; embedding: number[] }[],
  signals: UserSignals
): Map<string, ScoreResult> {
  const results = new Map<string, ScoreResult>();

  for (const post of posts) {
    const result = scorePost(post.authorDid, post.embedding, signals);
    results.set(post.uri, result);
  }

  return results;
}
