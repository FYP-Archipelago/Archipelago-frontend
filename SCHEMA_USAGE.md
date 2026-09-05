# Schema 2.0 Usage in archipelago-frontend

This document maps what the frontend **actually reads** from baseline-dEA's schema 2.0 logging contract. The harness produces far more data than this visualization needs; these are the fields that matter for Level 0 trajectory visualization, migration analysis, and convergence tracking.

Use this to trim logging overhead when generating test runs or when configuring the harness for specific analyses.

---

## evaluations.csv (The eval history)

**23 columns total in schema 2.0. Frontend uses 9 of them.**

### Used
| Column | Purpose | Required |
|--------|---------|----------|
| `run_id` | Join key to events | Yes, but rarely read |
| `island_id` | Which island evaluated this individual | **Yes** |
| `generation` | Which generation (per island) | **Yes** |
| `t_wall` | Wall-clock time since epoch (seconds) | **Yes** |
| `genome_hash` | Unique identifier for position in search space | **Yes** |
| `parent_ids` | Semi-colon list; empty for initial individuals | **Yes** (edges require this) |
| `fitness` | The evaluated objective value | **Yes** |
| `operator` | How this individual was created (crossover/mutation/etc.) | No (logged, not shown) |
| `genome_encoding` | Type of the genome (`real_vector`, `bitstring`, `permutation`, `expression_tree`) | **Yes** (decoding) |
| `genome_repr` | Packed representation (base64 compact or JSON full) | **Yes** (positioning) |
| `genome_repr_mode` | One of: `hashed`, `compact`, `full` | **Yes** (decoding strategy) |
| `is_island_best` | 1/0: is this the best seen by this island? | Yes (3D markers) |

### Not used
- `seq`, `eval_index` (row indexing; pandas uses positional)
- `objective` (always == `fitness` on scalar problems)
- `feasible`, `constraint_violation` (Level 0 ignores constraints)
- `genome_precision_decimals`, `genome_dim` (only needed if re-encoding)
- `origin_island`, `origin_individual_id` (migration ancestry; different from parent_ids)
- `t_mono_ns` (monotonic clock; frontend uses wall time only)

### Example: what a row looks like
```csv
run_id,island_id,seq,eval_index,generation,t_wall,t_mono_ns,individual_id,parent_ids,operator,fitness,objective,feasible,constraint_violation,is_island_best,genome_encoding,genome_hash,genome_repr,genome_repr_mode,genome_precision_decimals,genome_dim,origin_island,origin_individual_id
run-20260903T230942Z-c7f38cc1,0,142,142,2,1788476985.9840965,11934737000000,0-142,0-109;0-119,xover+mutate,45.2134,45.2134,1,,0,real_vector,a1b2c3d4e5f6...,HI4B/EErRkEHRmZGR0ZGRkdGRkdGRk...,compact,4,10,0,109
```

---

## run.jsonl (Event stream)

**8 event types. Frontend uses 6 of them.**

### Events Used

#### `run_start` (1 per run)
| Field | Purpose |
|-------|---------|
| `run_id` | Run identifier |
| `algorithm` | DE, PSO, GA, etc. |
| `benchmark` | Problem name (rastrigin, sphere, etc.) |
| `num_islands` | Number of islands K |
| `evaluation_budget` | Total evals across all islands |
| `migration.topology` | ring, fully_connected, etc. (reconstructs the network) |
| `migration.interval` | Generations between migration events |
| `migration.num_migrants` | How many per event |

**Where read:** `archipelago.py` (run provenance), `data.py` (sidebar), `pages/run_browser.py`

#### `generation_end` (many per run, ~20 per island)
| Field | Purpose |
|-------|---------|
| `island_id` | Which island completed a generation |
| `generation` | Generation number on that island |
| `t_wall` | Wall time when generation ended |
| `best_fitness` | Best fitness in that generation |
| `best_so_far_fitness` | Best since run start on this island |
| `mean_fitness`, `worst_fitness` | Population stats |
| `diversity` | Diversity metric (representation-dependent) |
| `diversity_metric` | Label of that metric (e.g., `mean_pairwise_euclidean_normalised`) |
| `unique_genome_hashes` | Count of unique genotypes |
| `evaluations_total` | Cumulative evals on this island |
| `migrants_received_this_generation` | Count |
| `maximising` | Boolean: is the objective maximized or minimized? |

**Where read:** `convergence.py` (the centrepiece — two charts per island, one for fitness and one for diversity)

#### `island_end` (1 per island)
| Field | Purpose |
|-------|---------|
| `island_id` | Which island |
| `termination_reason` | `max_generations`, `stagnation`, `max_evaluations`, `target_fitness`, etc. |
| `generations_reached` | Final generation on this island |
| `generation_when_improvement_stopped` | For stagnation math |

**Where read:** `run_browser.py` (the "How each island finished" table)

#### `migration_send` (one per migration event)
| Field | Purpose |
|-------|---------|
| `migration_id` | Unique identifier for this transfer batch |
| `source_island` | Which island sent |
| `dest_island` | Which island was the target |
| `source_generation` | Generation number on the source when sent |
| `num_migrants` | Count of individuals |
| `topology`, `selection_policy` | Metadata (logged, not shown) |
| `t_wall` | Timestamp of send |

**Where read:** `migration.py` (heatmap, timeline, latency analysis)

#### `migration_arrive` (typically equal to sends, but can be fewer)
| Field | Purpose |
|-------|---------|
| `migration_id` | Matches the send's ID |
| `dest_generation` | Generation number on dest island when arrival occurred |
| `accepted` | Boolean: was this batch accepted or rejected? |
| `latency_seconds` | Wall time between send and arrive |
| `generational_drift` | Dest generation - source generation (how "stale" the migrants are) |
| `replacement_policy` | Metadata |

**Where read:** `migration.py` (matches against sends to compute delivery rate and latency)

#### `island_start` (1 per island)
| Field | Purpose |
|-------|---------|
| `island_id` | Which island is starting |
| (others: diagnostics) | Not used by visualization |

**Where read:** Not directly used in views; `island_id` extracted to validate which islands exist

### Events NOT used

#### `diagnostic` (many per run)
Carries detailed profiling, queue sizes, and timing. Completely unused by Level 0. Safe to disable.

#### `run_end` (1 per run)
Carries summary stats that duplicate `summary.json`. Unused by frontend.

---

## summary.json (Machine-readable outcome)

**Not used by the frontend** except indirectly: the harness writes it, but all information it carries (per-island best fitness, total evals, termination reason, etc.) is already in the event stream. `Run.summary` is loaded but empty-dict defaults are used, so it's a no-op.

---

## Derived fields

The frontend computes several fields not directly in the log:

| Field | Definition | Why |
|-------|-----------|-----|
| `t_rel` | `t_wall - t_wall.min()` | Run-relative time (seconds since start), for normalizing timelines |
| `visits` | Count of evals at each (island, location) | Node sizing |
| `shared` | Whether >1 island visited a location | Special marker on 3D view |
| `is_island_best` | Boolean: is this node the best seen on its island? | Gold diamond markers |

---

## How to generate matching runs

### From baseline-dEA

```bash
python -m orchestrator.cli run --config config/smoke_local.yaml
```

The harness creates `runs/<timestamp>-<hash>/` with:
- `evaluations.csv` (one row per eval)
- `evaluations.schema.json` (schema definition)
- `run.jsonl` (event stream)
- `resolved_config.yaml` (the config that was actually used)
- `summary.json` (post-run aggregate)

### Minimal config for testing

If you want to trim logging (since Level 0 doesn't need everything), focus on:

```yaml
logging:
  genome_mode: compact          # compact > full (smaller, faster)
  genome_sample_every: 1        # sample every eval (frontend needs all)
  log_evaluations: true         # REQUIRED
  compress: false               # keep uncompressed (frontend expects CSV)
  write_island_shards: false    # optional; master shard is all we need
  stream_to_master: true        # collect on master
  flush_interval_seconds: 2.0   # batching; doesn't hurt
```

Don't disable:
- evaluations.csv logging
- `generation_end` events (convergence page needs them)
- `migration_send` / `migration_arrive` (migration page needs them)
- `island_end` events (run browser needs them)

Safe to disable:
- `diagnostic` events (zero frontend impact)
- `device_metrics` (was in schema 1.x, removed in 2.0)
- Island shards (they're redundant with the master)

---

## How the contract is actually used

**evaluations.csv** → ancestry graph (parent_ids → edges), positions (genome_repr decoded), visits (hash counts)

**run.jsonl: generation_end** → convergence tracking (fitness and diversity over wall time per island)

**run.jsonl: migration_{send,arrive}** → migration heatmap, latency analysis, delivery tracking

**run.jsonl: {run_start, island_end}** → provenance, per-island stopping reason, budget consumption

---

## Schema evolution

This is schema 2.0 (current). If baseline-dEA changes the format:
- New fields are ignored by the frontend (it's defensive)
- Renamed fields break loading; the frontend will error with a clear message
- Removed fields cause dataframe column access to fail (also clear)

The frontend reads only the contract, so it should be forwards-compatible within the same major version (2.x), and the specific field list above is what breaks between versions.
