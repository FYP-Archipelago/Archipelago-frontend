/**
 * The schema 2.0 read contract — the subset of the log this app actually reads.
 *
 * Mirrors `SCHEMA_USAGE.md`. Deliberately a subset: the harness writes more than
 * this, and the point of naming exactly what we consume is that a change to
 * anything else cannot break the frontend.
 */

/** One row of `evaluations.csv`. Strings as they come off the wire. */
export interface EvaluationRow {
  island_id: number;
  eval_index: number;
  individual_id: string;
  /** Semicolon-separated ids, empty for an init row. */
  parent_ids: string;
  operator: string;
  fitness: number;
  is_island_best: boolean;
  genome_encoding: string;
  genome_hash: string;
  genome_repr: string;
  genome_repr_mode: string;
  t_rel: number;
}

/** A record from `run.jsonl`. Discriminated on `type` — never `event`. */
export interface LogEvent {
  type: string;
  [key: string]: unknown;
}

export interface IslandEndEvent extends LogEvent {
  type: "island_end";
  island_id: number;
  best_genome_hash: string | null;
}

export interface MigrationArriveEvent extends LogEvent {
  type: "migration_arrive";
  migration_id: string;
  source_island: number;
  dest_island: number;
  origin_individual_ids: string[];
  arrived_individual_ids: string[];
  accepted?: boolean;
}

/**
 * A node key, `"<island>:<genome_hash>"`.
 *
 * This is the join key against `assignments` from the clustering API, so its
 * exact shape is load-bearing across two repositories. It has one producer, and
 * this is it.
 */
export function nodeKey(island: number, genomeHash: string): string {
  return `${Math.trunc(island)}:${genomeHash}`;
}

/** Node flag bits, packed so the node table stays a typed array. */
export const enum NodeFlag {
  IslandBest = 1,
  FinalBest = 2,
  Shared = 4,
}
