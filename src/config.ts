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

  // Jetstream
  jetstreamUrl: optional(
    'JETSTREAM_URL',
    'wss://jetstream2.us-east.bsky.network/subscribe'
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
