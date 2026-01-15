import { config } from '../config.js';
import { getPostsWithoutEmbeddings, insertPostEmbeddingsBatch } from '../db.js';
import { generateEmbeddings } from './embeddings.js';

// Worker configuration
// Reduced batch size for 1536-dim embeddings to avoid memory spikes
const BATCH_SIZE = 100; // Posts per batch
const WORKER_INTERVAL_MS = 10000; // Run every 10 seconds
const MAX_POSTS_PER_RUN = 200; // Limit posts processed per run to avoid long-running batches

let workerInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

// Stats for monitoring
const stats = {
  totalProcessed: 0,
  totalErrors: 0,
  lastRunProcessed: 0,
  lastRunErrors: 0,
  lastRunDurationMs: 0,
  pendingEstimate: 0,
  startedAt: Date.now(),
};

export function getEmbeddingWorkerStats() {
  const uptimeMs = Date.now() - stats.startedAt;
  const uptimeMinutes = uptimeMs / 1000 / 60;
  const processedPerMinute =
    uptimeMinutes > 0 ? Math.round(stats.totalProcessed / uptimeMinutes) : 0;

  return {
    ...stats,
    uptimeMinutes: Math.round(uptimeMinutes),
    processedPerMinute,
  };
}

async function processEmbeddingBatch(): Promise<void> {
  if (isProcessing) {
    return; // Skip if previous run is still processing
  }

  if (!config.openaiApiKey) {
    return; // No API key configured
  }

  isProcessing = true;
  const startTime = Date.now();
  let processed = 0;
  let errors = 0;

  try {
    // Get posts that need embeddings
    const posts = await getPostsWithoutEmbeddings(MAX_POSTS_PER_RUN);

    if (posts.length === 0) {
      stats.pendingEstimate = 0;
      return;
    }

    stats.pendingEstimate = posts.length;

    // Process in batches
    for (let i = 0; i < posts.length; i += BATCH_SIZE) {
      const batch = posts.slice(i, i + BATCH_SIZE);
      const texts = batch.map((p) => p.text);

      try {
        const embeddings = await generateEmbeddings(texts);

        // Batch insert all embeddings
        const items = batch.map((p, j) => ({
          uri: p.uri,
          embedding: embeddings[j],
        }));
        await insertPostEmbeddingsBatch(items);
        processed += batch.length;
      } catch (err) {
        errors += batch.length;
        console.error('Error processing embeddings batch:', err);
      }
    }
  } catch (err) {
    console.error('Error in embedding worker:', err);
  } finally {
    isProcessing = false;
    const duration = Date.now() - startTime;

    stats.totalProcessed += processed;
    stats.totalErrors += errors;
    stats.lastRunProcessed = processed;
    stats.lastRunErrors = errors;
    stats.lastRunDurationMs = duration;

    if (processed > 0 || errors > 0) {
      console.log(
        `Embeddings: processed=${processed}, errors=${errors}, duration=${duration}ms, pending=${stats.pendingEstimate - processed}`
      );
    }
  }
}

export function startEmbeddingWorker(): void {
  if (workerInterval) {
    console.log('Embedding worker already running');
    return;
  }

  if (!config.openaiApiKey) {
    console.log('Embedding worker disabled (no OPENAI_API_KEY)');
    return;
  }

  console.log(
    `Starting embedding worker (interval: ${WORKER_INTERVAL_MS}ms, batch: ${BATCH_SIZE})`
  );

  // Run immediately on start
  processEmbeddingBatch();

  // Then run periodically
  workerInterval = setInterval(processEmbeddingBatch, WORKER_INTERVAL_MS);
}

export function stopEmbeddingWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('Embedding worker stopped');
  }
}
