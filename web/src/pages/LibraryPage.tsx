/**
 * The run library: every run this app can read, and the way to add one.
 *
 * Archipelago reads finished runs; it does not execute them. A run from the
 * baseline harness, from Volpe or from a colleague is the same object here -- a
 * directory holding the schema 2.0 files -- so adding one is only a copy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Card, Empty, Loading, PageHeader, Table, fmt } from "../components/ui.js";

interface LibraryRun {
  id: string;
  files: string[];
  bytes: number;
  summary: Record<string, unknown> | null;
}

/** The only files a run holds. Anything else in a picked folder is ignored. */
const CONTRACT = [
  "evaluations.csv", "run.jsonl", "evaluations.schema.json", "resolved_config.yaml", "summary.json",
] as const;

/** What a run loses if a file is missing, said plainly. */
const MISSING_COSTS: Record<string, string> = {
  "run.jsonl": "no migrations, convergence or provenance",
  "summary.json": "no library figures",
  "evaluations.schema.json": "no schema check",
  "resolved_config.yaml": "no configuration record",
};

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function LibraryPage({ currentRun, onOpen, onChanged }: {
  currentRun: string | null;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [runs, setRuns] = useState<LibraryRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/library")
      .then((r) => r.json() as Promise<{ runs: LibraryRun[] }>)
      .then((body) => setRuns(body.runs))
      .catch(() => setError("Could not read the run library."));
  }, []);
  useEffect(load, [load]);

  const remove = async (id: string) => {
    if (armed !== id) {
      setArmed(id);
      return;
    }
    setArmed(null);
    const response = await fetch(`/library/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) setError(`Could not remove ${id}.`);
    load();
    onChanged();
  };

  return (
    <div className="page">
      <PageHeader eyebrow="The library" title="Runs">
        Archipelago reads finished runs; it does not execute them. Bring one in from the baseline
        harness, from Volpe, or from a colleague, and every page works on it.
      </PageHeader>

      <Card
          wide
          title="In the library"
          note="Figures come from each run's summary.json without parsing its evaluations, so this list stays fast however large the library grows."
        >
          {error !== null && <p className="form-error">{error}</p>}
          {runs === null ? (
            <Loading label="Reading the library…" />
          ) : runs.length === 0 ? (
            <Empty>No runs yet. Add one on the right.</Empty>
          ) : (
            <Table
              rows={runs}
              rowKey={(r) => r.id}
              columns={[
                {
                  label: "Run",
                  value: (r) => (
                    <span className="run-cell">
                      <code>{r.id}</code>
                      {r.id === currentRun && <span className="tag tag-ok">open</span>}
                    </span>
                  ),
                },
                { label: "Islands", value: (r) => num(r.summary?.["islands_completed"]) ?? "—", numeric: true },
                {
                  label: "Evaluations",
                  value: (r) => num(r.summary?.["total_evaluations"])?.toLocaleString() ?? "—",
                  numeric: true,
                },
                {
                  label: "Migrations",
                  value: (r) => num(r.summary?.["total_migration_events"])?.toLocaleString() ?? "—",
                  numeric: true,
                },
                { label: "Best", value: (r) => fmt(num(r.summary?.["global_best_fitness"])), numeric: true },
                { label: "Outcome", value: (r) => String(r.summary?.["termination_reason"] ?? "—") },
                { label: "Size", value: (r) => `${(r.bytes / 1e6).toFixed(1)} MB`, numeric: true },
                {
                  label: "",
                  value: (r) => (
                    <span className="row-actions">
                      <button className="btn btn-quiet" onClick={() => onOpen(r.id)}>Open</button>
                      <button
                        className={armed === r.id ? "btn btn-danger" : "btn btn-quiet"}
                        onClick={() => void remove(r.id)}
                        onBlur={() => setArmed((a) => (a === r.id ? null : a))}
                      >
                        {armed === r.id ? "Confirm" : "Remove"}
                      </button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Card>

      <div className="grid-2">
        <AddRun
          existing={runs?.map((r) => r.id) ?? []}
          onAdded={(id) => { load(); onChanged(); onOpen(id); }}
        />

      <Card title="What a run is">
        <pre className="code">{`run-<timestamp>-<id>/
├── evaluations.csv          every evaluation   (required)
├── run.jsonl                every event
├── evaluations.schema.json  the CSV's columns
├── resolved_config.yaml     the configuration
└── summary.json             the totals`}</pre>
      </Card>
      </div>
    </div>
  );
}

function AddRun({ existing, onAdded }: { existing: string[]; onAdded: (id: string) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);
  const filesRef = useRef<HTMLInputElement | null>(null);

  // Folder pickers are not in React's typed props; set them on the element.
  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  }, []);

  const picked = useMemo(() => {
    const byName = new Map<string, File>();
    for (const file of files) {
      if ((CONTRACT as readonly string[]).includes(file.name) && !byName.has(file.name)) {
        byName.set(file.name, file);
      }
    }
    return byName;
  }, [files]);

  const choose = (list: FileList | null) => {
    const chosen = list === null ? [] : [...list];
    setFiles(chosen);
    setProblem(null);
    // Default the name from the folder the files came from.
    const path = (chosen[0] as File & { webkitRelativePath?: string } | undefined)?.webkitRelativePath ?? "";
    const folder = path.includes("/") ? path.split("/")[0]! : "";
    if (folder !== "") setName(folder.replace(/[^A-Za-z0-9._-]/g, "-"));
    else if (name === "") setName(`uploaded-${new Date().toISOString().slice(0, 10)}`);
  };

  const unique = (base: string) => {
    let candidate = base;
    for (let i = 2; existing.includes(candidate); i += 1) candidate = `${base}-${i}`;
    return candidate;
  };

  const upload = async () => {
    const trimmed = name.trim();
    if (!picked.has("evaluations.csv")) {
      setProblem("A run needs evaluations.csv -- everything else is optional.");
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(trimmed)) {
      setProblem("Names may use letters, digits, dot, dash and underscore, starting with a letter or digit.");
      return;
    }
    const id = unique(trimmed);
    setBusy(true);
    setProblem(null);
    try {
      for (const [file, blob] of picked) {
        const response = await fetch(`/library/${encodeURIComponent(id)}/${file}`, { method: "PUT", body: blob });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `${file} was refused (${response.status}).`);
        }
      }
      setFiles([]);
      setName("");
      onAdded(id);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const missing = CONTRACT.filter((f) => f !== "evaluations.csv" && !picked.has(f));

  return (
    <Card title="Add a run">
      <p className="card-lede">
        Pick a run folder, or its files. Only the five contract files are copied; anything else in the
        folder is left behind.
      </p>
      <div className="pick-row">
        <button className="btn" onClick={() => folderRef.current?.click()}>Choose folder…</button>
        <button className="btn btn-quiet" onClick={() => filesRef.current?.click()}>Choose files…</button>
        <input ref={folderRef} type="file" hidden onChange={(e) => choose(e.target.files)} />
        <input ref={filesRef} type="file" multiple hidden onChange={(e) => choose(e.target.files)} />
      </div>

      {files.length > 0 && (
        <>
          <ul className="file-list">
            {CONTRACT.map((file) => (
              <li key={file} className={picked.has(file) ? "has" : "lacks"}>
                <code>{file}</code>
                <span>
                  {picked.has(file)
                    ? `${((picked.get(file)!.size) / 1e6).toFixed(2)} MB`
                    : file === "evaluations.csv" ? "required" : "missing"}
                </span>
              </li>
            ))}
          </ul>
          {missing.length > 0 && picked.has("evaluations.csv") && (
            <p className="card-note">
              Missing files cost: {missing.map((f) => `${f} (${MISSING_COSTS[f]})`).join("; ")}.
            </p>
          )}
          <label className="field">
            <span>Name in the library</span>
            <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          </label>
          <button className="btn btn-primary" disabled={busy} onClick={() => void upload()}>
            {busy ? "Adding…" : "Add to library"}
          </button>
        </>
      )}
      {problem !== null && <p className="form-error">{problem}</p>}
    </Card>
  );
}
