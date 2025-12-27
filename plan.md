# Rayleigh: Semantic Bluesky Feed & Client

## Vision
Build a custom Bluesky feed algorithm that is **semantic** and **interpretable**, paired with a custom client that surfaces rich explanations of why each post is recommended (or not).

---

## High-Level Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Bluesky        │────▶│  Feed Generator  │────▶│  Custom Client  │
│  Firehose/API   │     │  (Algorithm)     │     │  (UI)           │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │
                              ▼
                        ┌──────────────────┐
                        │  Semantic Engine │
                        │  (Embeddings,    │
                        │   Explanations)  │
                        └──────────────────┘
```

### Core Components

1. **Data Ingestion** - Subscribe to Bluesky firehose or poll relevant feeds
2. **Semantic Processing** - Generate embeddings, extract topics, classify content
3. **Scoring & Ranking** - Score posts based on your preferences with explainable rules
4. **Feed Generator Service** - Serve the custom feed via AT Protocol
5. **Custom Client** - Display feed with explanations for each post's ranking

---

## Design Decisions

### Functional Requirements

- **Rich semantic understanding** - Not just keyword matching; need to capture nuance
- **Scale** - Must process every Bluesky post (firehose is ~50-100 posts/sec, spikes higher)
- **Latency** - Minutes, not hours; near-real-time feel
- **ML-based approach** - Simple rules won't capture the diversity of interests
- **Interpretable** - Understand *why* each post is recommended
- **Multi-user** - Independent preferences per user; design for small scale (friends)

### Non-Functional Requirements & Principles

| Principle | Decision | Rationale |
|-----------|----------|-----------|
| **Budget** | $200/month hard cap | Personal project |
| **Cost predictability** | Critical - prefer shutdown over surprise bills | No variable costs that could spike |
| **Managed services** | Preferred | Less infra time, more algorithm time |
| **Reliability** | Moderate | Posts are ephemeral (~2 day value); natural recovery |
| **Data durability** | Low | Single points of failure acceptable |
| **Privacy/Security** | High | Only authorized users access the system |
| **Evolvability** | High | Frequent algorithm experimentation expected |
| **Observability** | Low initially | Enough to debug; interpretability covers "why" |
| **Data retention** | Tiered | Hot: recent posts for feed; Cold: historical for analysis |
| **Backfill** | Nice to have | Not critical if we miss some posts |
| **Dev velocity** | High | Fast iteration, but not at expense of quality |
| **Code quality** | High | Linting, automated tests, industry best practices |
| **Local development** | Nice to have | Ability to test algorithm changes locally |
| **CI/CD** | GitHub Actions | Do things right, not cut corners |

### Content Interests (Examples)

- News and politics
- Sports (Phillies, Eagles specifically)
- Cute corgis
- Technology and software engineering
- Educational/informational content
- Insightful commentary
- Humor

*"I contain multitudes"* - The algorithm must handle diverse, evolving interests

### Preference Model

**Explore/Exploit Balance**
- **Exploit**: Surface posts matching known interests (high confidence, satisfying)
- **Explore**: Surface potentially valuable posts outside known interests (discovery, serendipity)
- Need a tunable balance - maybe user-controlled "discovery dial"?

**Temporal Dynamics**
- Interest signals should **decay over time** without reinforcement
- Recent positive signals weight more than old ones
- Allows interests to naturally fade (e.g., sports off-season, passing news events)

**Negative Preferences (Anti-interests)**
- Explicitly model what you *don't* want to see
- Learn from negative feedback, not just positive
- May need different decay rates (negative signals might persist longer?)

**Conceptual Model**
```
Post Score = exploit_score + exploration_bonus - penalty

Where:
  exploit_score = Σ (facet_similarity × facet_weight × time_decay)
  exploration_bonus = quality_signal × novelty × explore_coefficient
  penalty = Σ (anti_facet_similarity × anti_weight)
```

### Feedback System (Decided)

**Build Order**: Algorithm/feed first → Custom client later

**Phase 1: Bootstrap with Bluesky Likes**
- Pull historical likes to initialize preference model
- Continue ingesting likes as ongoing positive signal
- Limited but gets us started without custom client

**Phase 2: Rich Feedback via Custom Client**
- **Text annotations**: Write a sentence about why a post is good/bad
  - "Great explanation of a complex topic"
  - "Rage bait, not substantive"
  - These can be embedded to refine facet definitions
- **Quick reactions**: 👍/👎 for lower-friction feedback
- **Implicit signals**: Dwell time, scroll patterns, click-through
- **Explicit controls**: "More/less like this", facet assignment

**Philosophy**: More effort in = better algorithm out. Design data model to capture all signal types from the start.

**Potential use of text feedback**:
- Embed annotations to cluster similar feedback
- LLM analysis: "You tend to like posts that are..."
- Use as training data for explanation generation

### Architecture Challenge

**The tension:** Rich semantic understanding (LLMs) is slow/expensive, but we need to process ~5-10M posts/day with minute-level latency.

**Possible approach: Tiered processing**
```
Firehose → Fast Filter → Embedding → Candidate Scoring → (Optional) LLM Enrichment
   │            │             │              │                    │
   │      Drop obvious    Vector DB     Top candidates      Rich explanations
   │      non-matches     indexing      get detailed        for display
   │                                    scoring
   ▼
~100/sec    ~35/sec        ~35/sec        ~1000s/day          ~100s/day
```

**Pre-embedding filters (Fast Filter):**
- **Language**: English only (use post `langs` field or fast detection)
- **Reposts**: Drop native reposts (no added commentary)
- **Exact duplicates**: Hash-based dedup (same text = skip)
- **Future**: Near-duplicate detection (fuzzy matching)

Estimated reduction: ~100 posts/sec → ~35 posts/sec (~65% filtered)

### Refined Requirements

**Scale & Performance**
- 5 users maximum (initial version)
- Process ~50-100 posts/sec from firehose
- Post-to-recommendation latency: < 5 minutes
- Feed serving: cursor-based infinite scroll

**Data Retention**
- Hot storage: 1-2 days of posts (indexed, scorable)
- Recommending posts older than ~2 days is considered a bug
- Historical feedback data retained longer for preference learning

**Reliability & Operations**
- Graceful degradation: nice-to-have, not required
- Alerting (email) required for subtle failures (missed ingestion, degraded recommendations)
- Brief ingestion gaps during deploys: acceptable

**Security & Authorization**
- Admin access: single user for all backend systems
- Client access: each user sees only their own data/preferences
- Simple auth model; no complex RBAC needed

**Evolvability**
- Algorithm experimentation: high priority
- A/B testing, historical backtesting: future roadmap, not v1

### Tech Stack (Decided)

**Language: TypeScript** (all components)
- Unified language for feed generator + future client
- Official AT Protocol SDK (`@atproto/api`)
- Strong typing for complex preference/scoring system
- Clean async model for firehose processing

**Embedding approach:**
- OpenAI `text-embedding-3-small` API ($0.02/1M tokens)
- Reduced dimensions (512 instead of 1536) for storage efficiency with modest quality tradeoff
- Budget cap: $100/month for embeddings (~5B tokens/month, ~3.3M posts/day capacity)
- What to embed (text only vs including link previews/alt text): configurable, experiment later

**Database:** PostgreSQL with pgvector (Fly.io managed Postgres)

**Client platform (Phase 2):** TBD - likely web app (React/Next.js) for code reuse

### Hosting

**Platform:** Fly.io
- Low ops overhead, focus on algorithm not infra
- Container-based: local dev parity with production
- IaC via `fly.toml` + Terraform provider available
- Predictable costs (provision-based, not pure usage-based)
- Managed Postgres with pgvector extension
- Good fit for persistent WebSocket (firehose connection)

**Feed Identity:** Bluesky account (did:plc) - simpler than did:web, no domain required

**Multi-user approach:** Single feed, personalized by requester DID
- All users subscribe to the same feed URI
- Feed API receives requester's DID with each request
- Return personalized results based on that user's preferences
- Whitelist DIDs to restrict access (non-whitelisted users get empty feed)

### Cost Budget

| Component | Est. Cost | Notes |
|-----------|-----------|-------|
| **OpenAI Embeddings** | ~$90/mo (cap $100) | 3M posts/day × 50 tokens × $0.02/1M |
| **Fly.io Compute** | $5-15/mo | Shared CPU for firehose + API |
| **Fly.io Postgres** | $15-30/mo | Dedicated instance + storage |
| **Storage (vectors)** | $10-20/mo | ~25GB vectors (512-dim), posts, indexes |
| **Buffer** | $35-60/mo | Growth, spikes, unexpected costs |
| **Total** | ~$120-155/mo | Under $200 cap |

**Storage math (with 512 dimensions):**
- 6M posts retained (2 days × 3M/day)
- 6M × 512 dims × 4 bytes = ~12GB vectors
- Plus post text, metadata, indexes → ~25-40GB total

---

## Development Roadmap

### Stage 0: Minimal Feed (Prove the Plumbing)
**Goal:** See posts flowing through your own feed in Bluesky

- [ ] Firehose ingestion → store English posts in Postgres
- [ ] Feed API endpoint → return recent posts (chronological)
- [ ] Deploy to Fly.io
- [ ] Subscribe to feed in Bluesky app

**No ML, no scoring.** Just prove infra works.

**Feedback loop:** Open Bluesky, see your feed working.

---

### Stage 1: Pre-filtering
- [ ] Add language detection (English only)
- [ ] Filter reposts
- [ ] Hash-based dedup

---

### Stage 2: Embeddings + Basic Scoring
- [ ] Integrate OpenAI embeddings API
- [ ] Store vectors in pgvector
- [ ] Pull user's Bluesky likes
- [ ] Score posts by similarity to liked posts

---

### Stage 3: Preference Model
- [ ] Implement facet-based scoring
- [ ] Add temporal decay
- [ ] Tune explore/exploit balance

---

### Stage 4: Custom Client (Phase 2)
- [ ] Web app for rich feedback
- [ ] Explanations for recommendations
- [ ] Text annotations, quick reactions
