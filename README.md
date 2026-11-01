# Archipelago JavaScript rewrite

JavaScript implementation of the Archipelago frontend. No Streamlit or Python code is used by this app.

## Run

```bash
cd js-rewrite
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. Vite proxies API calls to the Node server on port 4174. Runs and clustering results live in this checkout's `data/` directory. The directory is created automatically and ignored by Git; users can upload runs from the Runs page.

For clustered views, start the existing `archipelago-api` service separately. Set `ARCHIPELAGO_API_URL` before starting this app or change the service URL on the Runs page. The clustering service itself is outside this frontend rewrite.

## What was ported

- The six Streamlit pages and their sidebar navigation, controls, charts, tables, and run management.
- Schema 2.0 CSV and JSONL reading, compact genome decoding, PCA projection, and viewer payload preparation.
- Clustering API calls, stage controls, result persistence, and per-sample cluster labels.
- The WebGL2 network viewer and its CSS are copied from `archipelago_ui/viewer/frontend/`; only its Streamlit message bridge is replaced by a React mount adapter.

The Node server handles local paths and upload archives because browsers cannot safely read arbitrary directories.

## Production

```bash
npm ci
npm run build
npm start
```

The Node server serves the built UI and API together at <http://127.0.0.1:4174>. Set `HOST=0.0.0.0` and `PORT` for a container or hosting platform. Persist `data/` as a writable volume if uploaded runs should survive redeploys. The repository and Docker image include no run data.

```bash
docker build -t archipelago-js .
docker run -p 4174:4174 -v archipelago-runs:/app/data archipelago-js
```

For clustered views, set `ARCHIPELAGO_API_URL` to the separately deployed clustering service URL. The Runs page can also override it for the current session.

## Design

Colour tokens and the workspace layout live in `src/designs.css`. Island hues, migration cyan and best-solution pink are data encodings and are never themed.

## Check

```bash
npm test
npm run build
```
