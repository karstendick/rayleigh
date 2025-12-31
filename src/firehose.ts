import WebSocket from 'ws';
import { config } from './config.js';
import { insertPost, insertPostEmbedding } from './db.js';
import { getDedupStats, initDedup, isDuplicate, stopDedup } from './dedup.js';
import { generateEmbedding } from './scoring/embeddings.js';

// Jetstream event types
interface JetstreamEvent {
  did: string;
  time_us: number;
  kind: 'commit' | 'identity' | 'account';
  commit?: CommitEvent;
}

interface CommitEvent {
  rev: string;
  operation: 'create' | 'update' | 'delete';
  collection: string;
  rkey: string;
  record?: PostRecord;
  cid: string;
}

interface PostRecord {
  $type: string;
  text: string;
  createdAt: string;
  langs?: string[];
  reply?: unknown;
  embed?: unknown;
}

let ws: WebSocket | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let isShuttingDown = false;

// Stats for monitoring with filter breakdown
let stats = {
  received: 0,
  indexed: 0,
  embedded: 0,
  embeddingErrors: 0,
  filteredNoText: 0,
  filteredNotEnglish: 0,
  filteredDuplicate: 0,
  errors: 0,
  lastEventTime: Date.now(),
};

export function getFirehoseStats() {
  const totalFiltered =
    stats.filteredNoText + stats.filteredNotEnglish + stats.filteredDuplicate;
  return {
    ...stats,
    totalFiltered,
    dedup: getDedupStats(),
  };
}

function isEnglishPost(record: PostRecord): boolean {
  // Check langs array for English
  if (record.langs && record.langs.length > 0) {
    return record.langs.some((lang) => lang === 'en' || lang.startsWith('en-'));
  }
  // If no langs specified, skip (conservative approach)
  return false;
}

function hasText(record: PostRecord): boolean {
  // Skip posts with no text (quote posts without commentary, etc.)
  return typeof record.text === 'string' && record.text.trim().length > 0;
}

function sanitizeText(text: string): string {
  // Remove null bytes (0x00) which PostgreSQL rejects in text fields
  return text.replaceAll('\0', '');
}

async function handleEvent(event: JetstreamEvent): Promise<void> {
  stats.received++;
  stats.lastEventTime = Date.now();

  // Only process commit events
  if (event.kind !== 'commit' || !event.commit) {
    return;
  }

  const { commit } = event;

  // Only process post creations
  if (
    commit.operation !== 'create' ||
    commit.collection !== 'app.bsky.feed.post'
  ) {
    return;
  }

  // Must have a record
  if (!commit.record) {
    return;
  }

  const record = commit.record;

  // Filter: must have text
  if (!hasText(record)) {
    stats.filteredNoText++;
    return;
  }

  // Filter: must be English
  if (!isEnglishPost(record)) {
    stats.filteredNotEnglish++;
    return;
  }

  // Filter: duplicate text
  if (isDuplicate(record.text)) {
    stats.filteredDuplicate++;
    return;
  }

  // Build the post URI
  const uri = `at://${event.did}/${commit.collection}/${commit.rkey}`;
  const text = sanitizeText(record.text);

  try {
    await insertPost({
      uri,
      cid: commit.cid,
      authorDid: event.did,
      text,
      createdAt: new Date(record.createdAt),
    });
    stats.indexed++;

    // Generate and store embedding (non-blocking for firehose flow)
    if (config.openaiApiKey) {
      generateEmbedding(text)
        .then((embedding) => insertPostEmbedding(uri, embedding))
        .then(() => {
          stats.embedded++;
        })
        .catch((err) => {
          stats.embeddingErrors++;
          console.error('Error generating embedding:', err);
        });
    }
  } catch (error) {
    stats.errors++;
    console.error('Error inserting post:', error);
  }
}

function connect(): void {
  if (isShuttingDown) return;

  // Build URL with query params
  const url = new URL(config.jetstreamUrl);
  url.searchParams.set('wantedCollections', 'app.bsky.feed.post');

  console.log(`Connecting to Jetstream: ${url.toString()}`);

  ws = new WebSocket(url.toString());

  ws.on('open', () => {
    console.log('Connected to Jetstream');
    // Reset stats on reconnect
    stats = {
      received: 0,
      indexed: 0,
      embedded: 0,
      embeddingErrors: 0,
      filteredNoText: 0,
      filteredNotEnglish: 0,
      filteredDuplicate: 0,
      errors: 0,
      lastEventTime: Date.now(),
    };
  });

  ws.on('message', async (data: WebSocket.Data) => {
    try {
      const event = JSON.parse(data.toString()) as JetstreamEvent;
      await handleEvent(event);
    } catch (error) {
      stats.errors++;
      console.error('Error processing message:', error);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  ws.on('close', (code, reason) => {
    console.log(`WebSocket closed: ${code} - ${reason.toString()}`);
    ws = null;

    if (!isShuttingDown) {
      // Reconnect after 5 seconds
      console.log('Reconnecting in 5 seconds...');
      reconnectTimeout = setTimeout(connect, 5000);
    }
  });
}

export function startFirehose(): void {
  isShuttingDown = false;
  initDedup();
  connect();

  // Log stats every minute
  setInterval(() => {
    const s = stats;
    const totalFiltered =
      s.filteredNoText + s.filteredNotEnglish + s.filteredDuplicate;
    const elapsed = (Date.now() - s.lastEventTime) / 1000;
    const embeddingInfo = config.openaiApiKey
      ? `, embedded=${s.embedded}, embeddingErrors=${s.embeddingErrors}`
      : '';
    console.log(
      `Firehose: received=${s.received}, indexed=${s.indexed}${embeddingInfo}, filtered=${totalFiltered} (noText=${s.filteredNoText}, notEnglish=${s.filteredNotEnglish}, duplicate=${s.filteredDuplicate}), errors=${s.errors}, lastEvent=${elapsed.toFixed(1)}s ago`
    );
  }, 60000);
}

export function stopFirehose(): void {
  isShuttingDown = true;

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  if (ws) {
    ws.close();
    ws = null;
  }

  stopDedup();
  console.log('Firehose stopped');
}
