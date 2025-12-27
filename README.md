# Rayleigh

A semantic Bluesky feed generator that learns your interests.

**Current status:** Stage 0 - Minimal feed showing recent English posts (no ML yet).

## Architecture

```
Bluesky Jetstream → Firehose Ingestion → PostgreSQL → Feed API → Bluesky Client
                         ↓
                   Filter: English only
```

## Project Structure

```
src/
├── index.ts        # Entry point - starts server + firehose
├── config.ts       # Environment configuration
├── db.ts           # PostgreSQL schema + queries
├── firehose.ts     # Jetstream subscription (filters English posts)
└── server.ts       # Express feed API (getFeedSkeleton)

scripts/
└── publishFeed.ts  # Registers feed with Bluesky
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

2. Start PostgreSQL (using Docker):
   ```bash
   docker run -d --name rayleigh-db \
     -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=rayleigh \
     -p 5432:5432 \
     postgres:16
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

### 3. Get Your Feed Account's DID

```bash
curl "https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=rayleigh-feed.bsky.social"
```

### 4. Create App Password

Go to: https://bsky.app/settings/app-passwords

Create a new app password for the `rayleigh-feed.bsky.social` account.

### 5. Set Secrets

```bash
fly secrets set FEED_PUBLISHER_DID=did:plc:your-did-here
fly secrets set FEED_HOSTNAME=rayleigh-feed.fly.dev
fly secrets set BLUESKY_HANDLE=rayleigh-feed.bsky.social
fly secrets set BLUESKY_APP_PASSWORD=your-app-password
```

### 6. Deploy

```bash
fly deploy
```

### 7. Publish Feed to Bluesky

After deployment, register the feed:

```bash
pnpm publish-feed
```

### 8. Subscribe to Your Feed

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

## Roadmap

- [x] **Stage 0:** Minimal feed (chronological English posts)
- [ ] **Stage 1:** Pre-filtering (language detection, dedup)
- [ ] **Stage 2:** Embeddings + basic scoring
- [ ] **Stage 3:** Preference model with temporal decay
- [ ] **Stage 4:** Custom client with explanations

See [plan.md](plan.md) for detailed design decisions.
