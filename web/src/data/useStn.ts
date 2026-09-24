/**
 * The trajectory network for one run, built in a worker.
 *
 * Lives above the pages, so moving between tabs never re-reads or re-decodes a
 * run. Changing a layout option re-projects inside the same worker; only a new
 * run starts a new one.
 */

import { useEffect, useRef, useState } from "react";

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

export function useStn(runId: string | null, options: LayoutOptions): StnState {
  const [state, setState] = useState<StnState>({ payload: null, layout: null, phase: null, error: null });
  const workerRef = useRef<Worker | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const readyRef = useRef(false);

  useEffect(() => {
    if (runId === null) return;
    readyRef.current = false;
    setState({ payload: null, layout: null, phase: "starting", error: null });

    const worker = new Worker(new URL("./worker/data.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "phase") {
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

  return state;
}
