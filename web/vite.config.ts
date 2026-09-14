import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = resolve(ROOT, "..", "data");

/**
 * Serve the run library straight off disk in development.
 *
 * The runs live in the repo's `data/` directory, which sits outside Vite's root,
 * and the browser cannot read the filesystem. This is the development stand-in
 * for the Arrow endpoints the API grows at M5 — same URLs, so the client does not
 * change when the real ones arrive.
 */
function runLibrary(): Plugin {
  return {
    name: "archipelago-run-library",
    configureServer(server) {
      server.middlewares.use("/runs", (req, res, next) => {
        const path = (req.url ?? "").split("?")[0] ?? "";

        // GET /runs -> the runs that actually have data in them
        if (path === "/" || path === "") {
          const runs = existsSync(DATA_DIR)
            ? readdirSync(DATA_DIR).filter((name) =>
                existsSync(join(DATA_DIR, name, "evaluations.csv")),
              )
            : [];
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ runs }));
          return;
        }

        // GET /runs/<id>/<file>
        const [, runId = "", file = ""] = path.split("/");
        const target = join(DATA_DIR, runId, file);
        if (!target.startsWith(DATA_DIR) || !existsSync(target) || !statSync(target).isFile()) {
          next();
          return;
        }
        res.setHeader(
          "content-type",
          file.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8",
        );
        res.end(readFileSync(target));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), runLibrary()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 5173 },
  worker: { format: "es" },
  test: {
    globals: true,
    environment: "node",
    // The golden fixtures are a few hundred KB each and the largest run builds
    // ~11k nodes; the default 5s is tight on a cold run.
    testTimeout: 30_000,
  },
});
