import { useEffect, useState } from "react";

import { parseEvents } from "../contract/rows.js";
import { deriveRunFacts, type RunFacts } from "./runEvents.js";

/** A run's event stream, parsed and turned into the tables the pages read. */
export function useRunFacts(runId: string | null): { facts: RunFacts | null; error: string | null } {
  const [facts, setFacts] = useState<RunFacts | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (runId === null) return;
    let live = true;
    setFacts(null);
    setError(null);
    fetch(`/runs/${runId}/run.jsonl`)
      .then((response) => (response.ok ? response.text() : ""))
      .then((text) => { if (live) setFacts(deriveRunFacts(parseEvents(text))); })
      .catch((e: unknown) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [runId]);

  return { facts, error };
}
