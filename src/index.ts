import { config } from './config.js';
import { initializeDatabase, closeDatabase, cleanupOldPosts } from './db.js';
import { startFirehose, stopFirehose } from './firehose.js';
import { startServer } from './server.js';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function main(): Promise<void> {
  console.log('Starting Rayleigh feed generator...');
  console.log(`Feed publisher DID: ${config.feedPublisherDid}`);
  console.log(`Service DID: ${config.serviceDid}`);

  // Initialize database
  await initializeDatabase();

  // Start the HTTP server
  await startServer();

  // Start the firehose subscription
  startFirehose();

  // Schedule cleanup every hour
  setInterval(async () => {
    try {
      const deleted = await cleanupOldPosts();
      if (deleted > 0) {
        console.log(`Cleaned up ${deleted} old posts`);
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
