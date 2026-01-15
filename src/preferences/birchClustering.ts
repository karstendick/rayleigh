import { Birch, createPythonBridge } from 'sklearn';
import { logMemory } from '../utils/memory.js';

// Type for the Python bridge returned by createPythonBridge
type PyBridge = Awaited<ReturnType<typeof createPythonBridge>>;

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

// Hardcoded optimal number of clusters (determined via MDL analysis)
const N_CLUSTERS = 8;

// BIRCH parameters (determined via experimentation)
const BIRCH_THRESHOLD = 0.5;
const BIRCH_BRANCHING_FACTOR = 50;

// Singleton Python bridge (reused across calls)
let pyBridge: PyBridge | null = null;
let pyBridgePromise: Promise<PyBridge> | null = null;

// Singleton BIRCH model (kept in memory for incremental updates)
let birchModel: InstanceType<typeof Birch> | null = null;

/**
 * Get or create the Python bridge (singleton)
 */
async function getPythonBridge(): Promise<PyBridge> {
  if (pyBridge) {
    return pyBridge;
  }

  if (pyBridgePromise) {
    return pyBridgePromise;
  }

  pyBridgePromise = createPythonBridge().then((bridge) => {
    pyBridge = bridge;
    console.log('[BIRCH] Python bridge initialized');
    return bridge;
  });

  return pyBridgePromise;
}

/**
 * Compute centroid of a set of embeddings
 */
function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dims = embeddings[0].length;
  const centroid = new Array(dims).fill(0);

  for (const emb of embeddings) {
    for (let i = 0; i < dims; i++) {
      centroid[i] += emb[i];
    }
  }

  for (let i = 0; i < dims; i++) {
    centroid[i] /= embeddings.length;
  }

  return centroid;
}

/**
 * Compute Euclidean distance between two vectors
 */
function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Build cluster reports from labels and embeddings
 */
function buildClusterReports(
  posts: ClusteringInput[],
  embeddings: number[][],
  labels: number[]
): ClusterResult[] {
  // Group posts by cluster
  const clusterMap = new Map<number, { uri: string; embedding: number[] }[]>();

  for (let i = 0; i < posts.length; i++) {
    const label = labels[i];
    if (!clusterMap.has(label)) {
      clusterMap.set(label, []);
    }
    clusterMap.get(label)!.push({
      uri: posts[i].uri,
      embedding: embeddings[i],
    });
  }

  // Build cluster results
  const clusters: ClusterResult[] = [];

  for (const [clusterId, members] of clusterMap.entries()) {
    const clusterEmbeddings = members.map((m) => m.embedding);
    const centroid = computeCentroid(clusterEmbeddings);

    // Find exemplars: posts closest to centroid
    const membersWithDistance = members.map((m) => ({
      ...m,
      distance: euclideanDistance(m.embedding, centroid),
    }));
    membersWithDistance.sort((a, b) => a.distance - b.distance);
    const exemplarUris = membersWithDistance.slice(0, 5).map((m) => m.uri);

    clusters.push({
      clusterId,
      centroid,
      exemplarUris,
      size: members.length,
    });
  }

  // Sort by size (largest first)
  clusters.sort((a, b) => b.size - a.size);

  return clusters;
}

/**
 * Perform initial BIRCH clustering on a set of posts
 *
 * This creates a new BIRCH model and fits it on all provided posts.
 * The model is kept in memory for subsequent incremental updates.
 *
 * @param posts - Array of posts with embeddings
 * @returns Promise resolving to array of clusters with centroids and exemplar URIs
 */
export async function clusterWithBirch(
  posts: ClusteringInput[]
): Promise<ClusterResult[]> {
  if (posts.length < N_CLUSTERS * 2) {
    console.log(
      `[BIRCH] Not enough posts (${posts.length}) for clustering with k=${N_CLUSTERS}`
    );
    return [];
  }

  const py = await getPythonBridge();
  const embeddings = posts.map((p) => p.embedding);

  console.log(
    `[BIRCH] Clustering ${posts.length} posts (k=${N_CLUSTERS}, threshold=${BIRCH_THRESHOLD})...`
  );
  logMemory(`birch:start:${posts.length}`);

  const start = performance.now();

  // Dispose old model if it exists
  if (birchModel) {
    await birchModel.dispose();
    birchModel = null;
  }

  // Create new BIRCH model
  birchModel = new Birch({
    threshold: BIRCH_THRESHOLD,
    branching_factor: BIRCH_BRANCHING_FACTOR,
    n_clusters: N_CLUSTERS,
    compute_labels: true,
  });

  await birchModel.init(py);

  // Fit and get labels
  const labels: number[] = await birchModel.fit_predict({ X: embeddings });
  logMemory(`birch:fit_predict:${posts.length}`);

  const elapsed = performance.now() - start;
  console.log(`[BIRCH] Clustering completed in ${elapsed.toFixed(0)}ms`);

  // Build and return cluster reports
  const clusters = buildClusterReports(posts, embeddings, labels);
  console.log(`[BIRCH] Found ${clusters.length} clusters`);

  return clusters;
}

/**
 * Incrementally update the BIRCH model with new posts
 *
 * Uses partial_fit() to add new data points to the existing CF tree
 * without re-processing all previous data.
 *
 * @param newPosts - New posts to add to the model
 * @param allPosts - All posts (including new ones) for re-computing cluster assignments
 * @returns Promise resolving to updated clusters
 */
export async function incrementalUpdate(
  newPosts: ClusteringInput[],
  allPosts: ClusteringInput[]
): Promise<ClusterResult[]> {
  if (allPosts.length < N_CLUSTERS * 2) {
    console.log(
      `[BIRCH] Not enough posts (${allPosts.length}) for clustering with k=${N_CLUSTERS}`
    );
    return [];
  }

  const newEmbeddings = newPosts.map((p) => p.embedding);
  const allEmbeddings = allPosts.map((p) => p.embedding);

  // If no existing model, do full clustering
  if (!birchModel) {
    console.log('[BIRCH] No existing model, performing full clustering');
    return clusterWithBirch(allPosts);
  }

  console.log(
    `[BIRCH] Incremental update with ${newPosts.length} new posts...`
  );
  logMemory(`birch:incremental:start:${allPosts.length}`);

  const start = performance.now();

  // Use partial_fit to update the CF tree with new data
  await birchModel.partial_fit({ X: newEmbeddings });
  logMemory(`birch:partial_fit:${newPosts.length}`);

  // Re-predict labels for all posts
  // Note: After partial_fit, we need to re-cluster to get updated labels
  const labels: number[] = await birchModel.predict({ X: allEmbeddings });
  logMemory(`birch:predict:${allPosts.length}`);

  const elapsed = performance.now() - start;
  console.log(
    `[BIRCH] Incremental update completed in ${elapsed.toFixed(0)}ms`
  );

  // Build and return cluster reports
  const clusters = buildClusterReports(allPosts, allEmbeddings, labels);
  console.log(`[BIRCH] Updated to ${clusters.length} clusters`);

  return clusters;
}

/**
 * Reset the BIRCH model (e.g., for testing or when preferences are rebuilt)
 */
export async function resetBirchModel(): Promise<void> {
  if (birchModel) {
    await birchModel.dispose();
    birchModel = null;
    console.log('[BIRCH] Model reset');
  }
}

/**
 * Close the Python bridge (call on server shutdown)
 */
export async function closePythonBridge(): Promise<void> {
  if (birchModel) {
    await birchModel.dispose();
    birchModel = null;
  }
  if (pyBridge) {
    await pyBridge.disconnect();
    pyBridge = null;
    pyBridgePromise = null;
    console.log('[BIRCH] Python bridge closed');
  }
}
