# Rayleigh

A semantic Bluesky feed generator that learns your interests.

**Current status:** Personalized scoring using author + topic signals from your likes.

## Architecture

```
Bluesky Jetstream → Firehose Ingestion → PostgreSQL + pgvector → Feed API → Bluesky Client
                         ↓                      ↑
                   Filter: English         Scoring Worker
                   Generate Embeddings          ↓
                                          User Preferences
                                          (from likes analysis)
```

## How It Works

1. **Firehose ingestion**: Subscribes to Bluesky's Jetstream, filters English posts, generates embeddings
2. **Preference bootstrap**: Fetches your likes, clusters them into interest topics, tracks liked authors
3. **Scoring**: Combines two signals:
   - **Author signal**: Did you like posts from this author before? (2+ likes = signal)
   - **Topic signal**: How similar is this post to your interest clusters?
4. **Feed serving**: Returns posts ranked by combined score for whitelisted users

## Project Structure

```
src/
├── index.ts              # Entry point - starts all workers
├── config.ts             # Environment configuration
├── db.ts                 # PostgreSQL + pgvector schema
├── firehose.ts           # Jetstream subscription + embedding generation
├── server.ts             # Express feed API
├── scoring/
│   ├── embeddings.ts     # OpenAI embedding generation
│   ├── scorer.ts         # Author + topic scoring logic
│   └── worker.ts         # Background scoring worker
└── preferences/
    ├── bootstrap.ts      # Initial preference load from likes
    ├── clustering.ts     # HDBSCAN topic clustering
    ├── init.ts           # User initialization on startup
    └── refresh.ts        # Incremental preference updates

scripts/
├── publishFeed.ts        # Registers feed with Bluesky
└── explore-likes.ts      # Analyze likes to tune clustering params
```

## Local Development

### Prerequisites

- Node.js 20+
- pnpm
- PostgreSQL (or use Docker)

### Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Start PostgreSQL with pgvector (using Docker):
   ```bash
   docker run -d --name rayleigh-db \
     -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=rayleigh \
     -p 5432:5432 \
     pgvector/pgvector:pg16
   ```

   Then enable the extension:
   ```bash
   docker exec -it rayleigh-db psql -U postgres -d rayleigh -c "CREATE EXTENSION vector;"
   ```

3. Create `.env` file:
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

4. Run in development mode:
   ```bash
   pnpm dev
   ```

## Deployment (Fly.io)

### 1. Install Fly.io CLI

```bash
brew install flyctl
fly auth signup   # or: fly auth login
```

### 2. Create App and Database

```bash
fly launch --no-deploy
fly postgres create --name rayleigh-db
fly postgres attach rayleigh-db
```

### 3. Enable pgvector Extension

Go to your Fly.io dashboard → Apps → `rayleigh-db` → Extensions → Enable "vector"

Or use Managed Postgres with pgvector:
```bash
fly mpg create --name rayleigh-db --pgvector
```

### 4. Get Your Feed Account's DID

```bash
curl "https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=rayleigh-feed.bsky.social"
```

### 5. Create App Password

Go to: https://bsky.app/settings/app-passwords

Create a new app password for the `rayleigh-feed.bsky.social` account.

### 6. Set Secrets

```bash
fly secrets set FEED_PUBLISHER_DID=did:plc:your-did-here
fly secrets set FEED_HOSTNAME=rayleigh-feed.fly.dev
fly secrets set BLUESKY_HANDLE=rayleigh-feed.bsky.social
fly secrets set BLUESKY_APP_PASSWORD=your-app-password

# For personalized scoring (optional but recommended)
fly secrets set OPENAI_API_KEY=sk-your-key
fly secrets set BLUESKY_AUTH_HANDLE=your-handle.bsky.social
fly secrets set BLUESKY_AUTH_PASSWORD=your-app-password
fly secrets set WHITELISTED_HANDLES=your-handle.bsky.social
```

### 7. Deploy

```bash
fly deploy
```

### 8. Publish Feed to Bluesky

After deployment, register the feed:

```bash
pnpm publish-feed
```

### 9. Subscribe to Your Feed

In the Bluesky app, search for `@rayleigh-feed.bsky.social` and find the "Rayleigh" feed.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check with post count and firehose stats |
| `GET /.well-known/did.json` | DID document for did:web resolution |
| `GET /xrpc/app.bsky.feed.describeFeedGenerator` | Feed generator metadata |
| `GET /xrpc/app.bsky.feed.getFeedSkeleton` | Feed content (used by Bluesky) |
| `POST /admin/cleanup` | Manually trigger old post cleanup |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | Server port (default: 3000) |
| `HOST` | No | Server host (default: 0.0.0.0) |
| `FEED_PUBLISHER_DID` | Yes | DID of the Bluesky account publishing the feed |
| `FEED_HOSTNAME` | Yes | Hostname where the feed is deployed |
| `BLUESKY_HANDLE` | No | Handle for publishing feed (used by publish script) |
| `BLUESKY_APP_PASSWORD` | No | App password for publishing feed |
| `JETSTREAM_URL` | No | Jetstream WebSocket URL (default: us-east) |
| `OPENAI_API_KEY` | No* | OpenAI API key for embeddings |
| `BLUESKY_AUTH_HANDLE` | No* | Your Bluesky handle (for fetching likes) |
| `BLUESKY_AUTH_PASSWORD` | No* | App password for your account |
| `WHITELISTED_HANDLES` | No* | Comma-separated handles for personalized feeds |
| `EMBEDDING_MODEL` | No | OpenAI model (default: text-embedding-3-small) |
| `EMBEDDING_DIMENSIONS` | No | Embedding dimensions (default: 512) |
| `SCORING_BONUS_FACTOR` | No | Weight for secondary signal (default: 0.3) |
| `SCORING_INTERVAL_MS` | No | Scoring worker interval (default: 60000) |
| `PREFERENCES_REFRESH_INTERVAL_MS` | No | Preference refresh interval (default: 3600000) |

*Required for personalized scoring. Without these, all users get an empty feed.

## Roadmap

- [x] **Stage 0:** Minimal feed (chronological English posts)
- [ ] **Stage 1:** Pre-filtering (language detection, dedup)
- [ ] **Stage 2:** Embeddings + basic scoring
- [ ] **Stage 3:** Preference model with temporal decay
- [ ] **Stage 4:** Custom client with explanations

See [plan.md](plan.md) for detailed design decisions.
