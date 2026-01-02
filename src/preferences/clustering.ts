import { Worker } from 'node:worker_threads';

export interface ClusterResult {
  clusterId: number;
  centroid: number[];
  exemplarUris: string[];
  size: number;
}

export interface ClusteringInput {
  uri: string;
  embedding: number[];
}

/**
 * Cluster posts using HDBSCAN in a worker thread (non-blocking)
 *
 * @param posts - Array of posts with embeddings
 * @param minClusterSize - Minimum posts to form a cluster (default: 5)
 * @param minSamples - HDBSCAN min samples parameter (default: 1)
 * @returns Promise resolving to array of clusters with centroids and exemplar URIs
 */
export function clusterPosts(
  posts: ClusteringInput[],
  minClusterSize = 5,
  minSamples = 1
): Promise<ClusterResult[]> {
  if (posts.length < minClusterSize * 2) {
    console.log(
      `Not enough posts (${posts.length}) for clustering with minClusterSize=${minClusterSize}`
    );
    return Promise.resolve([]);
  }

  return new Promise((resolve, reject) => {
    const workerPath = new URL('./clusteringWorker.js', import.meta.url);

    const worker = new Worker(workerPath, {
      workerData: {
        posts,
        minClusterSize,
        minSamples,
      },
    });

    worker.on('message', (result: ClusterResult[]) => {
      resolve(result);
    });

    worker.on('error', (err) => {
      reject(err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Clustering worker exited with code ${code}`));
      }
    });
  });
}
