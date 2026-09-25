/**
 * The trajectory network for one run, built in a worker.
 *
 * Lives above the pages, so moving between tabs never re-reads or re-decodes a
 * run. Changing a layout option re-projects inside the same worker; only a new
 * run starts a new one. Inspecting a node asks the same worker, which already
 * holds the network, so the page only ever sends an index.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { Lineage, NodeDetail } from "./stn/inspect.js";
import type {
  LayoutOptions, LayoutPayload, StnPayload, WorkerRequest, WorkerResponse,
} from "./worker/data.worker.js";

export interface StnState {
  payload: StnPayload | null;
  layout: LayoutPayload | null;
  /** What the worker is doing, or null when idle. */
  phase: string | null;
  error: string | null;
}

export interface StnQueries {
  inspect: (index: number) => Promise<NodeDetail>;
  traceLineage: (index: number) => Promise<Lineage>;
}

type Pending = (response: WorkerResponse) => void;

export function useStn(runId: string | null, options: LayoutOptions): StnState & StnQueries {
  const [state, setState] = useState<StnState>({ payload: null, layout: null, phase: null, error: null });
  const workerRef = useRef<Worker | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const readyRef = useRef(false);
  const pending = useRef(new Map<number, Pending>());
  const nextId = useRef(1);

  useEffect(() => {
    if (runId === null) return;
    readyRef.current = false;
    pending.current.clear();
    setState({ payload: null, layout: null, phase: "starting", error: null });

    const worker = new Worker(new URL("./worker/data.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "detail" || message.type === "traced") {
        pending.current.get(message.id)?.(message);
        pending.current.delete(message.id);
      } else if (message.type === "phase") {
        setState((s) => ({ ...s, phase: message.phase }));
      } else if (message.type === "ready") {
        readyRef.current = true;
        setState({ payload: message.payload, layout: message.layout, phase: null, error: null });
      } else if (message.type === "layout") {
        // A new projection of the same run: the camera stays where the user
        // left it, so changing an option never throws the view somewhere else.
        setState((s) => ({ ...s, layout: message.layout, phase: null }));
      } else {
        setState((s) => ({ ...s, phase: null, error: message.message }));
      }
    };
    worker.postMessage({ type: "load", runId, layout: optionsRef.current } satisfies WorkerRequest);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [runId]);

  useEffect(() => {
    const worker = workerRef.current;
    if (worker === null || !readyRef.current) return;
    setState((s) => ({ ...s, phase: "projecting" }));
    worker.postMessage({ type: "relayout", layout: options } satisfies WorkerRequest);
  }, [options]);

  const ask = useCallback(<T,>(
    type: "inspect" | "lineage",
    index: number,
    pick: (response: WorkerResponse) => T,
  ): Promise<T> => new Promise((resolve, reject) => {
    const worker = workerRef.current;
    if (worker === null || !readyRef.current) {
      reject(new Error("The run is still loading."));
      return;
    }
    const id = nextId.current++;
    pending.current.set(id, (response) => resolve(pick(response)));
    worker.postMessage({ type, id, index } satisfies WorkerRequest);
  }), []);

  const inspect = useCallback((index: number) => ask("inspect", index, (r) => {
    if (r.type !== "detail") throw new Error("unexpected reply");
    return r.detail;
  }), [ask]);

  const traceLineage = useCallback((index: number) => ask("lineage", index, (r) => {
    if (r.type !== "traced") throw new Error("unexpected reply");
    return r.lineage;
  }), [ask]);

  return { ...state, inspect, traceLineage };
}
