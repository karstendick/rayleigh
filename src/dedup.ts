import pkg from 'bloom-filters';

const { BloomFilter } = pkg;

type BloomFilterInstance = InstanceType<typeof BloomFilter>;

// Configuration for bloom filters
const FILTER_CAPACITY = 5_000_000; // 5M items per filter
const FALSE_POSITIVE_RATE = 0.0001; // 0.01%
const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Two rotating filters: current and previous
let currentFilter: BloomFilterInstance;
let previousFilter: BloomFilterInstance;
let lastRotation: Date;
let rotationTimer: ReturnType<typeof setInterval> | null = null;

// Stats for monitoring
let dedupStats = {
  checked: 0,
  duplicatesFound: 0,
  itemsAdded: 0,
};

function createFilter(): BloomFilterInstance {
  return BloomFilter.create(FILTER_CAPACITY, FALSE_POSITIVE_RATE);
}

export function initDedup(): void {
  currentFilter = createFilter();
  previousFilter = createFilter();
  lastRotation = new Date();

  // Schedule daily rotation
  rotationTimer = setInterval(rotateFilters, ROTATION_INTERVAL_MS);

  console.log(
    `Bloom filters initialized: capacity=${FILTER_CAPACITY}, FP rate=${FALSE_POSITIVE_RATE}`
  );
}

export function stopDedup(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
}

function rotateFilters(): void {
  // Previous becomes garbage collected, current becomes previous, new current
  previousFilter = currentFilter;
  currentFilter = createFilter();
  lastRotation = new Date();

  console.log('Bloom filters rotated');
}

/**
 * Check if text has been seen before.
 * Returns true if it's a duplicate, false if it's new.
 * If new, automatically adds it to the current filter.
 */
export function isDuplicate(text: string): boolean {
  dedupStats.checked++;

  // Normalize text for comparison (trim, lowercase)
  const normalized = text.trim().toLowerCase();

  // Check both filters
  if (currentFilter.has(normalized) || previousFilter.has(normalized)) {
    dedupStats.duplicatesFound++;
    return true;
  }

  // Not a duplicate - add to current filter
  currentFilter.add(normalized);
  dedupStats.itemsAdded++;
  return false;
}

export interface DedupStats {
  checked: number;
  duplicatesFound: number;
  itemsAdded: number;
  currentFilterSize: number;
  lastRotation: Date;
  filterCapacity: number;
  falsePositiveRate: number;
}

export function getDedupStats(): DedupStats {
  return {
    ...dedupStats,
    currentFilterSize: currentFilter?.length ?? 0,
    lastRotation,
    filterCapacity: FILTER_CAPACITY,
    falsePositiveRate: FALSE_POSITIVE_RATE,
  };
}

export function resetDedupStats(): void {
  dedupStats = {
    checked: 0,
    duplicatesFound: 0,
    itemsAdded: 0,
  };
}
