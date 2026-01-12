declare module 'sklearn' {
  export interface BirchOptions {
    threshold?: number;
    branching_factor?: number;
    n_clusters?: number;
    compute_labels?: boolean;
  }

  export interface PyBridge {
    disconnect(): Promise<void>;
  }

  export class Birch {
    constructor(options?: BirchOptions);

    init(py: PyBridge): Promise<void>;
    dispose(): Promise<void>;

    fit(params: { X: number[][] }): Promise<void>;
    fit_predict(params: { X: number[][] }): Promise<number[]>;
    partial_fit(params: { X: number[][] }): Promise<void>;
    predict(params: { X: number[][] }): Promise<number[]>;

    readonly subcluster_centers_: Promise<number[][]>;
    readonly subcluster_labels_: Promise<number[]>;
    readonly labels_: Promise<number[]>;
  }

  export function createPythonBridge(): Promise<PyBridge>;
}
