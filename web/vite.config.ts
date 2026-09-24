import {
  createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = resolve(ROOT, "..", "data");

/** The run contract: the only files a run directory may hold. */
const RUN_FILES = new Set([
  "evaluations.csv",
  "run.jsonl",
  "evaluations.schema.json",
  "resolved_config.yaml",
  "summary.json",
]);

const hasRun = (name: string) => existsSync(join(DATA_DIR, name, "evaluations.csv"));

/** A directory name that cannot climb out of data/ or collide with a sibling. */
function safeName(raw: string): string | null {
  const name = decodeURIComponent(raw).trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name) ? name : null;
}

function inside(path: string): boolean {
  return resolve(path).startsWith(DATA_DIR + sep);
}

function sizeOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    total += stat.isFile() ? stat.size : 0;
  }
  return total;
}

/**
 * Serve the run library straight off disk in development.
 *
 * The runs live in the repo's `data/` directory, outside Vite's root, and a
 * browser cannot touch the filesystem. This is the development stand-in for the
 * API endpoints the plan puts in M5 -- same shape, so the client does not change
 * when the real ones arrive.
 *
 *   GET    /runs                    run names that hold data
 *   GET    /runs/<id>/<file>        one contract file
 *   GET    /library                 every run with its summary.json and size
 *   PUT    /library/<id>/<file>     add one contract file to a run (body = file)
 *   DELETE /library/<id>            remove a run
 */
function runLibrary(): Plugin {
  return {
    name: "archipelago-run-library",
    configureServer(server) {
      server.middlewares.use("/runs", (req, res, next) => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        if (path === "/" || path === "") {
          const runs = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter(hasRun).sort().reverse() : [];
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ runs }));
          return;
        }
        const [, runId = "", file = ""] = path.split("/");
        const target = join(DATA_DIR, runId, file);
        if (!RUN_FILES.has(file) || !inside(target) || !existsSync(target)) {
          next();
          return;
        }
        res.setHeader(
          "content-type",
          file.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8",
        );
        res.end(readFileSync(target));
      });

      server.middlewares.use("/library", (req, res) => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        const [, rawId = "", file = ""] = path.split("/");
        const reply = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };

        if (req.method === "GET" && (path === "/" || path === "")) {
          const runs = existsSync(DATA_DIR)
            ? readdirSync(DATA_DIR).filter(hasRun).sort().reverse().map((id) => {
                const dir = join(DATA_DIR, id);
                const summaryPath = join(dir, "summary.json");
                let summary: unknown = null;
                try {
                  summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf-8")) : null;
                } catch {
                  summary = null;
                }
                return {
                  id,
                  files: readdirSync(dir).filter((f) => RUN_FILES.has(f)),
                  bytes: sizeOf(dir),
                  summary,
                };
              })
            : [];
          reply(200, { runs });
          return;
        }

        const id = safeName(rawId);
        if (id === null) {
          reply(400, { error: "Run names may use letters, digits, dot, dash and underscore." });
          return;
        }
        const dir = join(DATA_DIR, id);
        if (!inside(dir)) {
          reply(400, { error: "That name resolves outside the run library." });
          return;
        }

        if (req.method === "PUT") {
          if (!RUN_FILES.has(file)) {
            reply(400, { error: `${file} is not part of a run. Expected one of: ${[...RUN_FILES].join(", ")}.` });
            return;
          }
          mkdirSync(dir, { recursive: true });
          const out = createWriteStream(join(dir, file));
          req.pipe(out);
          out.on("finish", () => reply(201, { id, file }));
          out.on("error", (error) => reply(500, { error: String(error) }));
          return;
        }

        if (req.method === "DELETE" && file === "") {
          if (!existsSync(dir)) {
            reply(404, { error: "No such run." });
            return;
          }
          rmSync(dir, { recursive: true, force: true });
          reply(200, { id, removed: true });
          return;
        }

        reply(405, { error: "Unsupported request." });
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
