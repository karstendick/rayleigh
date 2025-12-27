import 'dotenv/config';
import { AtpAgent } from '@atproto/api';

const FEED_RECORD_NAME = 'rayleigh';

async function main(): Promise<void> {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  const feedHostname = process.env.FEED_HOSTNAME;

  if (!handle || !password || !feedHostname) {
    console.error('Missing required environment variables:');
    console.error('  BLUESKY_HANDLE - Your Bluesky handle');
    console.error('  BLUESKY_APP_PASSWORD - App password for the account');
    console.error('  FEED_HOSTNAME - Hostname where feed is deployed');
    process.exit(1);
  }

  console.log(`Publishing feed for @${handle}...`);

  // Create agent and login
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier: handle, password });

  console.log(`Logged in as ${agent.session?.did}`);

  const publisherDid = agent.session?.did;
  if (!publisherDid) {
    throw new Error('Failed to get DID from session');
  }

  // Check if feed already exists
  const feedUri = `at://${publisherDid}/app.bsky.feed.generator/${FEED_RECORD_NAME}`;

  try {
    const existing = await agent.app.bsky.feed.getFeedGenerator({
      feed: feedUri,
    });
    console.log('Feed already exists:', existing.data.view.displayName);
    console.log('URI:', feedUri);
    console.log(
      'To update the feed, delete it first and run this script again.'
    );
    return;
  } catch {
    // Feed doesn't exist, continue to create
  }

  // Create the feed generator record
  const record = {
    did: `did:web:${feedHostname}`,
    displayName: 'Rayleigh',
    description:
      'A semantic feed that learns your interests.',
    createdAt: new Date().toISOString(),
  };

  console.log('Creating feed generator record...');
  console.log('Record:', JSON.stringify(record, null, 2));

  const response = await agent.app.bsky.feed.generator.create(
    { repo: publisherDid, rkey: FEED_RECORD_NAME },
    record
  );

  console.log('Feed published successfully!');
  console.log('URI:', response.uri);
  console.log('CID:', response.cid);
  console.log('');
  console.log('Next steps:');
  console.log(`1. Deploy your feed generator to ${feedHostname}`);
  console.log('2. Subscribe to the feed in Bluesky');
  console.log(`   Feed URI: ${feedUri}`);
}

main().catch((error) => {
  console.error('Error publishing feed:', error);
  process.exit(1);
});
