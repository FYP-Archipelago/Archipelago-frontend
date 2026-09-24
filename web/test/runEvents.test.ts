/**
 * The event-derived tables, checked against what the harness itself reports.
 *
 * `run_end` carries the harness's own totals, so the derived tables can be held
 * to them without a fixture: if a send went missing from the left join, or an
 * island_end was dropped, these would disagree with the log's own bookkeeping.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseEvents } from "../src/contract/rows.js";
import { deriveRunFacts, median } from "../src/data/runEvents.js";

const REPO = join(__dirname, "..", "..");
const RUNS = ["run-20260903T230942Z-c7f38cc1", "run-20260903T230838Z-4891f68f"];

describe.each(RUNS)("run facts: %s", (runId) => {
  const file = join(REPO, "data", runId, "run.jsonl");
  const available = existsSync(file);
  const facts = () => deriveRunFacts(parseEvents(readFileSync(file, "utf-8")));

  it.runIf(available)("keeps every send, delivered or not", () => {
    const f = facts();
    const end = f.runEnd!;
    expect(f.transfers.length).toBe(end["total_migration_events"]);
    const moved = f.transfers.reduce((sum, t) => sum + t.migrants, 0);
    expect(moved).toBe(end["total_migrants"]);
  });

  it.runIf(available)("has one outcome per island that finished", () => {
    const f = facts();
    expect(f.outcomes.length).toBe(f.runEnd!["islands_completed"]);
  });

  it.runIf(available)("puts the run's global best on the island the log names", () => {
    const f = facts();
    const end = f.runEnd!;
    const winner = f.outcomes.find((o) => o.island === end["global_best_island"])!;
    expect(winner.best).toBeCloseTo(end["global_best_fitness"] as number, 9);
  });

  it.runIf(available)("orders generations and starts the clock at zero", () => {
    const f = facts();
    expect(f.generations.length).toBeGreaterThan(0);
    expect(Math.min(...f.generations.map((g) => g.tRel))).toBe(0);
    for (let i = 1; i < f.generations.length; i += 1) {
      const a = f.generations[i - 1]!;
      const b = f.generations[i]!;
      expect(a.island < b.island || (a.island === b.island && a.generation < b.generation)).toBe(true);
    }
  });

  it.runIf(available)("never lets best-so-far get worse on an island", () => {
    const f = facts();
    const last = new Map<number, number>();
    for (const g of f.generations) {
      if (g.bestSoFar === null) continue;
      const prev = last.get(g.island);
      if (prev !== undefined) {
        expect(f.maximising ? g.bestSoFar >= prev : g.bestSoFar <= prev).toBe(true);
      }
      last.set(g.island, g.bestSoFar);
    }
  });
});

describe("median", () => {
  it("handles odd, even and empty input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
