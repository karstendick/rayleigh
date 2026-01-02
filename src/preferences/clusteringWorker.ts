import { parentPort, workerData } from 'node:worker_threads';
import { HDBSCAN } from 'hdbscan-ts';

interface ClusteringInput {
  uri: string;
  embedding: number[];
}

interface ClusterResult {
  clusterId: number;
  centroid: number[];
  exemplarUris: string[];
  size: number;
}

interface WorkerData {
  posts: ClusteringInput[];
  minClusterSize: number;
  minSamples: number;
}

function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);

  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i];
    }
  }

  for (let i = 0; i < dim; i++) {
    centroid[i] /= embeddings.length;
  }

  return centroid;
}

function clusterPosts(
  posts: ClusteringInput[],
  minClusterSize: number,
  minSamples: number
): ClusterResult[] {
  if (posts.length < minClusterSize * 2) {
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
    members.sort((a, b) => b.probability - a.probability);

    const clusterEmbeddings = members.map((m) => m.embedding);
    const centroid = computeCentroid(clusterEmbeddings);

    const exemplarUris = members.slice(0, 5).map((m) => m.uri);

    clusters.push({
      clusterId,
      centroid,
      exemplarUris,
      size: members.length,
    });
  }

  clusters.sort((a, b) => b.size - a.size);

  console.log(
    `[Worker] Clustering completed in ${elapsed.toFixed(0)}ms: ${clusters.length} clusters, ${noiseCount} noise posts`
  );

  return clusters;
}

// Run clustering with data passed from main thread
const { posts, minClusterSize, minSamples } = workerData as WorkerData;
const result = clusterPosts(posts, minClusterSize, minSamples);
parentPort?.postMessage(result);
