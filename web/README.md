# Archipelago web

The TypeScript frontend: React 19, Vite, three.js for the 3D scene, Observable
Plot for the charts. It reads the same schema 2.0 run directories as the
Streamlit app, from the repo's `data/` folder.

## Run it

With Docker (nothing else to install):

```bash
docker compose up --build        # from the repo root
```

Then open <http://localhost:5173>. `./data` is mounted as the run library, so
runs added on the Runs page are written there and survive the container.

Without Docker (Node 22):

```bash
cd web
npm install
npm run dev
```

## Check it

```bash
npm test            # golden tests against the Python builder, and the event tables
npm run typecheck
npm run build
```

`npm run golden` regenerates the golden fixtures from the Python builder on
`main`. Do that only when the Python side changes on purpose; the tests exist to
catch the two builders disagreeing.

## Where things are

| | |
|---|---|
| `src/contract/` | the log format: genome decoding, row mapping. Imports nothing else. |
| `src/data/stn/StnBuilder.ts` | the trajectory network, built incrementally, pinned to Python by tests |
| `src/data/runEvents.ts` | tables from `run.jsonl`: generations, transfers, outcomes, provenance |
| `src/data/worker/` | decode, build and layout, off the main thread |
| `src/layout/` | the two layouts: genome-space PCA (Jacobi, no linear-algebra dependency) and the time-pinned graph layout |
| `src/render/StnScene.tsx` | the 3D scene: Plotly-style turntable, walls, shaded point nodes |
| `src/pages/` | the six pages |
| `vite.config.ts` | also serves the run library (`/runs`, `/library`) to the dev and preview servers |

The run-library routes stand in for the API endpoints the rewrite plan puts in
its M5 milestone, with the same shape, so the pages will not change when those
arrive.
