import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export const config = {
  // Database
  databaseUrl: required('DATABASE_URL'),

  // Server
  port: parseInt(optional('PORT', '3000'), 10),
  host: optional('HOST', '0.0.0.0'),

  // Feed identity
  feedPublisherDid: required('FEED_PUBLISHER_DID'),
  feedHostname: required('FEED_HOSTNAME'),

  // Bluesky credentials (for publishing)
  blueskyHandle: optional('BLUESKY_HANDLE', ''),
  blueskyAppPassword: optional('BLUESKY_APP_PASSWORD', ''),

  // Bluesky auth (for fetching user likes)
  blueskyAuthHandle: optional('BLUESKY_AUTH_HANDLE', ''),
  blueskyAuthPassword: optional('BLUESKY_AUTH_PASSWORD', ''),

  // Jetstream
  jetstreamUrl: optional(
    'JETSTREAM_URL',
    'wss://jetstream2.us-east.bsky.network/subscribe'
  ),

  // OpenAI (for embeddings)
  openaiApiKey: optional('OPENAI_API_KEY', ''),
  embeddingModel: optional('EMBEDDING_MODEL', 'text-embedding-3-small'),
  embeddingDimensions: parseInt(optional('EMBEDDING_DIMENSIONS', '1536'), 10),

  // Whitelisted users (comma-separated handles)
  whitelistedHandles: optional('WHITELISTED_HANDLES', '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),

  // Scoring settings
  scoringBonusFactor: parseFloat(optional('SCORING_BONUS_FACTOR', '0.3')),
  scoringIntervalMs: parseInt(optional('SCORING_INTERVAL_MS', '60000'), 10),
  preferencesRefreshIntervalMs: parseInt(
    optional('PREFERENCES_REFRESH_INTERVAL_MS', '3600000'),
    10
  ),

  // Derived values
  get feedGeneratorDid(): string {
    return this.feedPublisherDid;
  },

  get serviceDid(): string {
    return `did:web:${this.feedHostname}`;
  },
} as const;

export type Config = typeof config;
