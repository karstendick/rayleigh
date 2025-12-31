import { HDBSCAN } from 'hdbscan-ts';
import { computeCentroid } from '../scoring/embeddings.js';

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
 * Cluster posts using HDBSCAN and extract cluster information
 *
 * @param posts - Array of posts with embeddings
 * @param minClusterSize - Minimum posts to form a cluster (default: 5)
 * @param minSamples - HDBSCAN min samples parameter (default: 1)
 * @returns Array of clusters with centroids and exemplar URIs
 */
export function clusterPosts(
  posts: ClusteringInput[],
  minClusterSize = 5,
  minSamples = 1
): ClusterResult[] {
  if (posts.length < minClusterSize * 2) {
    console.log(
      `Not enough posts (${posts.length}) for clustering with minClusterSize=${minClusterSize}`
    );
    return [];
  }

  const embeddings = posts.map((p) => p.embedding);

  const hdbscan = new HDBSCAN({
    minClusterSize,
    minSamples,
  });

  const start = performance.now();
  hdbscan.fit(embeddings);
  const elapsed = performance.now() - start;

  const labels = hdbscan.labels_;
  const probabilities = hdbscan.probabilities_;

  // Group posts by cluster
  const clusterMap = new Map<
    number,
    { uri: string; embedding: number[]; probability: number }[]
  >();

  let noiseCount = 0;
  for (let i = 0; i < posts.length; i++) {
    const label = labels[i];
    if (label === -1) {
      noiseCount++;
    } else {
      if (!clusterMap.has(label)) {
        clusterMap.set(label, []);
      }
      clusterMap.get(label)!.push({
        uri: posts[i].uri,
        embedding: posts[i].embedding,
        probability: probabilities[i],
      });
    }
  }

  // Build cluster results with centroids and exemplars
  const clusters: ClusterResult[] = [];

  for (const [clusterId, members] of clusterMap.entries()) {
    // Sort by probability (highest = most representative)
    members.sort((a, b) => b.probability - a.probability);

    // Compute centroid
    const clusterEmbeddings = members.map((m) => m.embedding);
    const centroid = computeCentroid(clusterEmbeddings);

    // Top 5 by probability are exemplars
    const exemplarUris = members.slice(0, 5).map((m) => m.uri);

    clusters.push({
      clusterId,
      centroid,
      exemplarUris,
      size: members.length,
    });
  }

  // Sort by size (largest first)
  clusters.sort((a, b) => b.size - a.size);

  console.log(
    `Clustering completed in ${elapsed.toFixed(0)}ms: ${clusters.length} clusters, ${noiseCount} noise posts`
  );

  return clusters;
}
