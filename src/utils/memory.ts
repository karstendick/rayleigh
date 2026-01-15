export interface MemoryStats {
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
}

/**
 * Get current memory usage stats
 */
export function getMemoryStats(): MemoryStats {
  const mem = process.memoryUsage();
  return {
    heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
    heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
    rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
  };
}

/**
 * Log current memory usage with a label for debugging memory issues
 */
export function logMemory(label: string): void {
  const { rssMB, heapUsedMB, heapTotalMB } = getMemoryStats();
  console.log(
    `[Memory:${label}] rss=${rssMB}MB, heap=${heapUsedMB}/${heapTotalMB}MB`
  );
}
