import { config } from './config.js';
import {
  cleanupOldPosts,
  cleanupOldScoredPosts,
  closeDatabase,
  initializeDatabase,
} from './db.js';
import { startFirehose, stopFirehose } from './firehose.js';
import { closePythonBridge } from './preferences/birchClustering.js';
import {
  initializeWhitelistedUsers,
  startPreferenceRefresh,
  stopPreferenceRefresh,
} from './preferences/init.js';
import {
  startEmbeddingWorker,
  stopEmbeddingWorker,
} from './scoring/embeddingWorker.js';
import { startScoringWorker, stopScoringWorker } from './scoring/worker.js';
import { startServer } from './server.js';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function main(): Promise<void> {
  console.log('Starting Rayleigh feed generator...');
  console.log(`Feed publisher DID: ${config.feedPublisherDid}`);
  console.log(`Service DID: ${config.serviceDid}`);
  console.log(
    `Whitelisted users: ${config.whitelistedHandles.join(', ') || '(none)'}`
  );
  console.log(`Embeddings: ${config.openaiApiKey ? 'enabled' : 'disabled'}`);

  // Initialize database
  await initializeDatabase();

  // Start the HTTP server
  await startServer();

  // Start the firehose subscription
  startFirehose();

  // Start the embedding worker (processes posts in batches)
  startEmbeddingWorker();

  // Initialize whitelisted users (resolve handles, bootstrap if needed)
  if (config.whitelistedHandles.length > 0 && config.openaiApiKey) {
    await initializeWhitelistedUsers();

    // Start the scoring worker
    startScoringWorker();

    // Start preference refresh job
    startPreferenceRefresh();
  }

  // Schedule cleanup every hour
  setInterval(async () => {
    try {
      const [deletedPosts, deletedScores] = await Promise.all([
        cleanupOldPosts(),
        cleanupOldScoredPosts(),
      ]);
      if (deletedPosts > 0 || deletedScores > 0) {
        console.log(
          `Cleaned up ${deletedPosts} old posts, ${deletedScores} old scores`
        );
      }
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }, CLEANUP_INTERVAL_MS);

  console.log('Rayleigh feed generator is running');
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down...`);

  stopFirehose();
  stopEmbeddingWorker();
  stopScoringWorker();
  stopPreferenceRefresh();
  await closePythonBridge();
  await closeDatabase();

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
