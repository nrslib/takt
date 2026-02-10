/**
 * Arpeggio movement internal type definitions.
 *
 * Configuration types (ArpeggioMovementConfig, ArpeggioMergeMovementConfig)
 * live in models/piece-types.ts as part of PieceMovement.
 * This file defines runtime types used internally by the arpeggio module.
 */

export type {
  ArpeggioMovementConfig,
  ArpeggioMergeMovementConfig,
} from '../../models/piece-types.js';

/** A single row of data from a data source (column name → value) */
export type DataRow = Record<string, string>;

/** A batch of rows read from a data source */
export interface DataBatch {
  /** The rows in this batch */
  readonly rows: readonly DataRow[];
  /** 0-based index of this batch in the overall data set */
  readonly batchIndex: number;
  /** Total number of batches (known after full read) */
  readonly totalBatches: number;
}

/** Interface for data source implementations */
export interface ArpeggioDataSource {
  /** Read all batches from the data source. Returns an array of DataBatch. */
  readBatches(batchSize: number): Promise<readonly DataBatch[]>;
}

/** Result of a single LLM call for one batch */
export interface BatchResult {
  /** 0-based index of the batch */
  readonly batchIndex: number;
  /** LLM response content */
  readonly content: string;
  /** Whether this result was successful */
  readonly success: boolean;
  /** Error message if failed */
  readonly error?: string;
}

/** Merge function signature: takes all batch results, returns merged string */
export type MergeFn = (results: readonly BatchResult[]) => string;
