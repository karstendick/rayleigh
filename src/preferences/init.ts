import { AtpAgent } from '@atproto/api';
import { config } from '../config.js';
import { getUserPreferences, upsertUserPreferences } from '../db.js';
import { bootstrapUserPreferences } from './bootstrap.js';
import { refreshUserPreferences } from './refresh.js';

interface WhitelistedUser {
  handle: string;
  did: string;
}

// Cache of resolved handles to DIDs
let resolvedUsers: WhitelistedUser[] = [];

/**
 * Resolve handles to DIDs using the Bluesky API
 */
async function resolveHandles(handles: string[]): Promise<WhitelistedUser[]> {
  if (handles.length === 0) return [];

  const agent = new AtpAgent({ service: 'https://bsky.social' });
  const users: WhitelistedUser[] = [];

  for (const handle of handles) {
    try {
      const response = await agent.resolveHandle({ handle });
      users.push({ handle, did: response.data.did });
      console.log(`  Resolved @${handle} -> ${response.data.did}`);
    } catch (error) {
      console.error(`  Failed to resolve @${handle}:`, error);
    }
  }

  return users;
}

/**
 * Initialize preferences for all whitelisted users
 *
 * For each user:
 * 1. Check if preferences exist
 * 2. If not, bootstrap from their likes
 * 3. Store the user in user_preferences table
 */
export async function initializeWhitelistedUsers(): Promise<void> {
  const handles = config.whitelistedHandles;

  if (handles.length === 0) {
    console.log('No whitelisted handles configured');
    return;
  }

  console.log(`\nInitializing ${handles.length} whitelisted user(s)...`);

  // Resolve handles to DIDs
  resolvedUsers = await resolveHandles(handles);

  if (resolvedUsers.length === 0) {
    console.log('No users could be resolved');
    return;
  }

  // Check and bootstrap each user
  for (const user of resolvedUsers) {
    const prefs = await getUserPreferences(user.did);

    if (prefs) {
      console.log(`  @${user.handle}: preferences exist, skipping bootstrap`);
    } else {
      console.log(`  @${user.handle}: no preferences, bootstrapping...`);

      // Create initial user preferences record
      await upsertUserPreferences({
        userDid: user.did,
        userHandle: user.handle,
      });

      // Bootstrap from likes
      try {
        await bootstrapUserPreferences(user.did, user.handle);
      } catch (error) {
        console.error(`  Failed to bootstrap @${user.handle}:`, error);
      }
    }
  }

  console.log('User initialization complete\n');
}

// Refresh interval handle
let refreshInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the preference refresh job
 * Runs at configured interval to update preferences for all whitelisted users
 */
export function startPreferenceRefresh(): void {
  if (refreshInterval) {
    console.log('Preference refresh already running');
    return;
  }

  const intervalMs = config.preferencesRefreshIntervalMs;
  console.log(
    `Starting preference refresh job (interval: ${intervalMs / 1000 / 60} minutes)`
  );

  refreshInterval = setInterval(async () => {
    console.log('Running preference refresh for all users...');

    for (const user of resolvedUsers) {
      try {
        await refreshUserPreferences(user.did);
      } catch (error) {
        console.error(`Error refreshing @${user.handle}:`, error);
      }
    }
  }, intervalMs);
}

/**
 * Stop the preference refresh job
 */
export function stopPreferenceRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    console.log('Preference refresh stopped');
  }
}
