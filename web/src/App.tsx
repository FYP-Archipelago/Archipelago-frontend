import { useCallback, useEffect, useMemo, useState } from "react";

import { BrandMark, ChevronIcon, MoonIcon, SunIcon } from "./components/icons.js";
import { useRunFacts } from "./data/useRunFacts.js";
import { useStn } from "./data/useStn.js";
import type { LayoutOptions } from "./data/worker/data.worker.js";
import { AboutPage } from "./pages/AboutPage.js";
import { ArchipelagoPage, DEFAULT_VIEW, type ViewState } from "./pages/ArchipelagoPage.js";
import { ConvergencePage } from "./pages/ConvergencePage.js";
import { LibraryPage } from "./pages/LibraryPage.js";
import { MigrationPage } from "./pages/MigrationPage.js";
import { RunPage } from "./pages/RunPage.js";
import { PAGES, href, usePage } from "./router.js";
import type { ThemeName } from "./theme/palette.js";
import "./theme/tokens.css";
import "./app.css";

const THEME_KEY = "archipelago-theme";
const RUN_KEY = "archipelago-run";
const VIEW_KEY = "archipelago-view";

/** Storage can be missing or throw (private windows); nothing here depends on it. */
function remember(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // not saved; the app still works
  }
}
function recall<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function applyTheme(theme: ThemeName): void {
  // Set synchronously, before anything re-renders: charts read their colours
  // from the computed tokens as they draw, and would otherwise catch the old ones.
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be unavailable (private windows); the theme still applies.
  }
}

/** Dark unless the viewer chose light; the choice is remembered per browser. */
function useTheme(): [ThemeName, () => void] {
  const [theme, setTheme] = useState<ThemeName>(() => {
    let initial: ThemeName = "dark";
    try {
      initial = localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
    } catch {
      // fall through to dark
    }
    applyTheme(initial);
    return initial;
  });
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);
  return [theme, toggle];
}

/**
 * The shell: a top bar with the pages, the run and the theme, and one page
 * below it. The run's network and its event log are loaded here, above the
 * pages, so moving between tabs never reloads anything.
 */
export default function App() {
  const [theme, toggleTheme] = useTheme();
  const page = usePage();

  const [runs, setRuns] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const refreshRuns = useCallback(() => {
    fetch("/runs")
      .then((r) => r.json() as Promise<{ runs: string[] }>)
      .then((body) => {
        setRuns(body.runs);
        // Keep the open run; otherwise reopen the one from last time.
        const last = recall<string>(RUN_KEY);
        setRunId((current) => {
          if (current !== null && body.runs.includes(current)) return current;
          if (last !== null && body.runs.includes(last)) return last;
          return body.runs[0] ?? null;
        });
        setListError(null);
      })
      .catch(() => setListError("Could not list runs. Is the dev server serving data/?"));
  }, []);
  useEffect(refreshRuns, [refreshRuns]);
  useEffect(() => { if (runId !== null) remember(RUN_KEY, runId); }, [runId]);

  useEffect(() => {
    const label = PAGES.find((p) => p.id === page)?.label ?? "Archipelago";
    document.title = page === "archipelago" ? "Archipelago" : `${label} · Archipelago`;
  }, [page]);

  // View options come back as they were left, merged over the defaults so a
  // setting added later still gets a value.
  const [view, setViewState] = useState<ViewState>(() => ({ ...DEFAULT_VIEW, ...recall<Partial<ViewState>>(VIEW_KEY) }));
  useEffect(() => remember(VIEW_KEY, view), [view]);
  const setView = useCallback((patch: Partial<ViewState>) => setViewState((v) => ({ ...v, ...patch })), []);
  const [hiddenIslands, setHiddenIslands] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => setHiddenIslands(new Set()), [runId]);

  const layoutOptions = useMemo<LayoutOptions>(() => ({
    kind: view.layoutKind,
    elevation: view.elevation,
    territories: view.territories,
    rankFitness: view.rankFitness,
    bestOnTop: view.bestOnTop,
  }), [view.layoutKind, view.elevation, view.territories, view.rankFitness, view.bestOnTop]);

  const stn = useStn(runId, layoutOptions);
  const { facts } = useRunFacts(runId);

  const openRun = useCallback((id: string) => {
    setRunId(id);
    window.location.hash = href("archipelago");
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href("archipelago")}>
          <BrandMark />
          <span className="brand-name">Archipelago</span>
        </a>

        <nav className="tabs" aria-label="Pages">
          {PAGES.map((p) => (
            <a key={p.id} href={href(p.id)} aria-current={page === p.id ? "page" : undefined}>
              {p.label}
            </a>
          ))}
        </nav>

        <div className="topbar-right">
          {runs.length > 0 && (
            <label className="picker">
              <span className="sr-only">Run</span>
              <select value={runId ?? ""} onChange={(e) => setRunId(e.target.value)}>
                {runs.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
              <ChevronIcon size={14} />
            </label>
          )}
          <button
            className="icon-btn"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <main className="main">
        {listError !== null && page !== "about" ? (
          <div className="page"><div className="empty empty-error">{listError}</div></div>
        ) : runs.length === 0 && page !== "library" && page !== "about" ? (
          <div className="page">
            <div className="empty">
              No runs in the library yet. <a href={href("library")}>Add one on the Runs page.</a>
            </div>
          </div>
        ) : (
          <>
            {page === "archipelago" && (
              <ArchipelagoPage
                runId={runId}
                stn={stn}
                theme={theme}
                view={view}
                setView={setView}
                hiddenIslands={hiddenIslands}
                setHiddenIslands={setHiddenIslands}
              />
            )}
            {page === "migration" && <MigrationPage facts={facts} theme={theme} />}
            {page === "convergence" && <ConvergencePage facts={facts} theme={theme} />}
            {page === "run" && <RunPage facts={facts} evaluations={null} />}
            {page === "library" && (
              <LibraryPage currentRun={runId} onOpen={openRun} onChanged={refreshRuns} />
            )}
            {page === "about" && <AboutPage />}
          </>
        )}
      </main>
    </div>
  );
}
