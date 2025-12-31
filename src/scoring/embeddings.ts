import OpenAI from 'openai';
import { config } from '../config.js';

// Lazy initialization of OpenAI client
let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is required for embedding generation');
    }
    openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openaiClient;
}

// Maximum batch size for OpenAI embeddings API
const EMBEDDING_BATCH_SIZE = 100;

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const openai = getOpenAI();

  const response = await openai.embeddings.create({
    model: config.embeddingModel,
    input: text,
    dimensions: config.embeddingDimensions,
  });

  return response.data[0].embedding;
}

/**
 * Generate embeddings for multiple texts in batches
 * Returns embeddings in the same order as input texts
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const openai = getOpenAI();
  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);

    const response = await openai.embeddings.create({
      model: config.embeddingModel,
      input: batch,
      dimensions: config.embeddingDimensions,
    });

    // OpenAI returns embeddings in the same order as input
    for (const item of response.data) {
      embeddings.push(item.embedding);
    }
  }

  return embeddings;
}

/**
 * Cosine similarity between two vectors (0 to 1, higher = more similar)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Compute centroid of a set of embeddings
 */
export function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];

  const dims = embeddings[0].length;
  const centroid = new Array(dims).fill(0);

  for (const emb of embeddings) {
    for (let i = 0; i < dims; i++) {
      centroid[i] += emb[i];
    }
  }

  for (let i = 0; i < dims; i++) {
    centroid[i] /= embeddings.length;
  }

  return centroid;
}
