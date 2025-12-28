import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { config } from './config.js';
import { cleanupOldPosts, getPostCount, getRecentPosts } from './db.js';
import { getFirehoseStats } from './firehose.js';

const app: Express = express();

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const postCount = await getPostCount();
    const firehoseStats = getFirehoseStats();
    res.json({
      status: 'ok',
      postCount,
      firehose: firehoseStats,
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: String(error) });
  }
});

// Well-known DID document (for did:web resolution)
app.get('/.well-known/did.json', (_req: Request, res: Response) => {
  res.json({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: config.serviceDid,
    service: [
      {
        id: '#bsky_fg',
        type: 'BskyFeedGenerator',
        serviceEndpoint: `https://${config.feedHostname}`,
      },
    ],
  });
});

// Describe feed generator
app.get(
  '/xrpc/app.bsky.feed.describeFeedGenerator',
  (_req: Request, res: Response) => {
    res.json({
      did: config.serviceDid,
      feeds: [
        {
          uri: `at://${config.feedPublisherDid}/app.bsky.feed.generator/rayleigh`,
        },
      ],
    });
  }
);

// Get feed skeleton
app.get(
  '/xrpc/app.bsky.feed.getFeedSkeleton',
  async (req: Request, res: Response) => {
    try {
      const feed = req.query.feed as string | undefined;
      const limit = Math.min(
        parseInt(req.query.limit as string, 10) || 50,
        100
      );
      const cursor = req.query.cursor as string | undefined;

      // Validate feed parameter
      const expectedFeed = `at://${config.feedPublisherDid}/app.bsky.feed.generator/rayleigh`;
      if (feed !== expectedFeed) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `Unknown feed: ${feed}`,
        });
        return;
      }

      // Get recent posts from database
      const posts = await getRecentPosts(limit, cursor);

      // Build response
      const feedItems = posts.map((post) => ({
        post: post.uri,
      }));

      // Create cursor from last item's indexed_at timestamp
      const nextCursor =
        posts.length > 0
          ? posts[posts.length - 1].indexedAt.getTime().toString()
          : undefined;

      res.json({
        feed: feedItems,
        cursor: nextCursor,
      });
    } catch (error) {
      console.error('Error getting feed skeleton:', error);
      res.status(500).json({
        error: 'InternalServerError',
        message: 'Failed to get feed',
      });
    }
  }
);

// Manual cleanup endpoint (for testing)
app.post('/admin/cleanup', async (_req: Request, res: Response) => {
  try {
    const deleted = await cleanupOldPosts();
    res.json({ deleted });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'InternalServerError',
    message: 'An unexpected error occurred',
  });
});

export function startServer(): Promise<void> {
  return new Promise((resolve) => {
    app.listen(config.port, config.host, () => {
      console.log(`Server listening on ${config.host}:${config.port}`);
      resolve();
    });
  });
}

export { app };
