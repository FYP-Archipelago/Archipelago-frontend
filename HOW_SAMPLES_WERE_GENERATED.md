# How the Sample Runs Were Generated

The two sample runs in `data/` were created using **baseline-dEA**'s orchestrator CLI. Both are real output from an actual harness run.

---

## Command

```bash
python -m orchestrator.cli run --config config/smoke_local.yaml
```

This invokes the harness with a configuration that defaults to:
- **Algorithm:** Differential Evolution (DE)
- **Problem:** Rastrigin (10-dimensional)
- **Backend:** Local (threads on one machine)

The harness creates a `runs/<timestamp>-<hash>/` directory with evaluations, events, and metadata.

---

## The Two Runs

Both were created by the same command, but with different migration topologies baked into baseline-dEA's config options. They demonstrate the effect of migration frequency on convergence.

### Run 1: Ring topology, interval 3
**Directory:** `data/run-20260903T230838Z-4891f68f/`

```
Algorithm:      DE (rand/1)
Problem:        Rastrigin, 10-D
Islands:        4
Population:     38 per island
Budget:         4,000 evaluations total
Migration:      Ring, every 3 generations
Events:         22 migration transfers
Duration:       ~2.1 seconds wall time
Global best:    65.09 (worse)
```

**Config equivalent:**
```yaml
algorithm: de
benchmark: rastrigin
num_islands: 4
migration:
  topology: ring
  interval: 3
  num_migrants: 2
evaluation_budget: 4000
```

### Run 2: Fully-connected, interval 1
**Directory:** `data/run-20260903T230942Z-c7f38cc1/`

```
Algorithm:      DE (rand/1)
Problem:        Rastrigin, 10-D
Islands:        5
Population:     38 per island
Budget:         4,000 evaluations total
Migration:      Fully-connected, every generation
Events:         324 migration transfers
Duration:       ~2.1 seconds wall time
Global best:    18.93 (much better)
```

**Config equivalent:**
```yaml
algorithm: de
benchmark: rastrigin
num_islands: 5
migration:
  topology: fully_connected
  interval: 1
  num_migrants: 2
evaluation_budget: 4000
```

---

## What to change to generate similar runs

### To skip expensive fields

The harness logs everything; to reduce I/O and file size:

```yaml
logging:
  # Use compact genome encoding (base64) instead of full JSON
  genome_mode: compact
  
  # Sample every eval (frontend needs all genomes)
  genome_sample_every: 1
  
  # Keep CSV uncompressed (frontend expects .csv, not .csv.gz)
  compress: false
  
  # Island shards are optional; master shard has everything
  write_island_shards: false
  
  # Don't validate event schemas (marginal overhead)
  validate_events: false
```

### To disable events Level 0 doesn't need

Safe to remove from config to reduce run.jsonl size:

```yaml
# Level 0 doesn't use these:
logging:
  log_diagnostics: false
  log_device_metrics: false
```

You **cannot** disable:
- `log_evaluations: true` — the entire archipelago.py view depends on this
- `generation_end` events — convergence.py needs per-island generation-level stats
- `migration_send` / `migration_arrive` — migration.py joins these

---

## How to find the exact config

Each run's directory contains `resolved_config.yaml`, which is the configuration that was actually used (defaults merged with CLI overrides). This is the ground truth:

```bash
cat data/run-20260903T230942Z-c7f38cc1/resolved_config.yaml
```

---

## Tracing back through the harness

If you need to modify or inspect the harness config:

1. Look in `baseline-dEA/config/` for YAML templates
2. The command above runs the **default** config unless `--config` points elsewhere
3. CLI overrides are applied on top: `--num-islands 8` would change `num_islands: 5`
4. Resolved config is dumped to `runs/<run id>/resolved_config.yaml` for reproducibility

---

## Why these two?

Ring + interval 3 → sparse migration, slow convergence (65.09)
Fully-connected + interval 1 → dense migration, fast convergence (18.93)

On a simple problem like Rastrigin, the difference is stark. Both ship so the
migration views have contrasting data: the ring run is sparse and structured,
the fully-connected run is dense and noisy. Together they show that the
visualization doesn't collapse or break under either extreme.

---

## Reproducing them exactly

```bash
cd baseline-dEA
python -m orchestrator.cli run --config config/smoke_local.yaml --num-islands 4 --migration-interval 3 > /dev/null
# Creates: runs/run-<timestamp>-<hash>/
cp -r runs/run-*/ /path/to/archipelago-frontend/data/
```

or

```bash
python -m orchestrator.cli run --config config/smoke_local.yaml --num-islands 5 --migration-interval 1 > /dev/null
# Creates: runs/run-<timestamp>-<hash>/
cp -r runs/run-*/ /path/to/archipelago-frontend/data/
```

The exact timestamp will differ, so you'll get new run IDs. That's fine — the frontend
just sorts runs by timestamp, so any new runs added to `data/` appear in the picker.
