import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { config } from './config.js';
import {
  cleanupOldPosts,
  cleanupOldScoredPosts,
  getClusterCount,
  getEmbeddingCount,
  getLikedAuthorCount,
  getPostCount,
  getScoredPosts,
  getScoringStats,
  getUserPreferences,
} from './db.js';
import { getFirehoseStats } from './firehose.js';
import { getEmbeddingWorkerStats } from './scoring/embeddingWorker.js';
import { getMemoryStats } from './utils/memory.js';

// Decode JWT to get requester DID (without verification - Bluesky handles auth)
function getRequesterDid(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  try {
    // JWT is base64url encoded: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Decode payload (second part)
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );
    return payload.iss || null;
  } catch {
    return null;
  }
}

const app: Express = express();

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const t0 = Date.now();

    const [postCount, embeddingCount, firehoseStats, scoringStats] =
      await Promise.all([
        getPostCount(),
        getEmbeddingCount(),
        Promise.resolve(getFirehoseStats()),
        getScoringStats(),
      ]);

    const t1 = Date.now();
    console.log(`/health: initial queries took ${t1 - t0}ms`);

    const embeddingRate =
      postCount > 0 ? ((embeddingCount / postCount) * 100).toFixed(1) : '0';

    // Get signals for each user (using count queries for performance)
    const usersWithSignals = await Promise.all(
      scoringStats.users.map(async (u) => {
        const [likedAuthors, clusters] = await Promise.all([
          getLikedAuthorCount(u.userDid),
          getClusterCount(u.userDid),
        ]);
        return {
          handle: u.userHandle,
          scoredPosts: u.scoredPosts,
          likedAuthors,
          clusters,
        };
      })
    );

    const t2 = Date.now();
    console.log(`/health: user signals took ${t2 - t1}ms`);
    console.log(`/health: total ${t2 - t0}ms`);

    const embeddingWorkerStats = getEmbeddingWorkerStats();
    const embeddingBacklog = postCount - embeddingCount;

    res.json({
      status: 'ok',
      posts: {
        total: postCount,
        withEmbeddings: embeddingCount,
        embeddingBacklog,
        embeddingRate: `${embeddingRate}%`,
      },
      firehose: firehoseStats,
      embeddingWorker: embeddingWorkerStats,
      scoring: {
        whitelistedUsers: scoringStats.users.length,
        totalScoredPosts: scoringStats.totalScoredPosts,
        users: usersWithSignals,
      },
      memory: getMemoryStats(),
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

      // Get requester DID from JWT
      const requesterDid = getRequesterDid(req);

      // Check if requester is whitelisted (has preferences)
      let isWhitelisted = false;
      if (requesterDid) {
        const prefs = await getUserPreferences(requesterDid);
        isWhitelisted = prefs !== null;
      }

      if (isWhitelisted && requesterDid) {
        // Return personalized scored feed
        const scoredPosts = await getScoredPosts(requesterDid, limit, cursor);

        const feedItems = scoredPosts.map((post) => ({
          post: post.uri,
        }));

        // Cursor format: "score:timestamp"
        const nextCursor =
          scoredPosts.length > 0
            ? `${scoredPosts[scoredPosts.length - 1].score}:${scoredPosts[scoredPosts.length - 1].scoredAt.getTime()}`
            : undefined;

        res.json({
          feed: feedItems,
          cursor: nextCursor,
        });
      } else {
        // Non-whitelisted users get empty feed
        res.json({
          feed: [],
          cursor: undefined,
        });
      }
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
    const [deletedPosts, deletedScores] = await Promise.all([
      cleanupOldPosts(),
      cleanupOldScoredPosts(),
    ]);
    res.json({ deletedPosts, deletedScores });
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
