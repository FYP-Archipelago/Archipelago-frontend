/**
 * Hash routing, which is all six fixed pages need.
 *
 * `#/migration` survives a reload and works from a static file server with no
 * rewrite rules, which matters for the Docker image serving plain files.
 */

import { useEffect, useState } from "react";

export const PAGES = [
  { id: "archipelago", label: "Archipelago" },
  { id: "migration", label: "Migration" },
  { id: "convergence", label: "Convergence" },
  { id: "run", label: "Run" },
  { id: "library", label: "Runs" },
  { id: "about", label: "About" },
] as const;

export type PageId = (typeof PAGES)[number]["id"];

function read(): PageId {
  const id = window.location.hash.replace(/^#\/?/, "");
  return (PAGES.find((p) => p.id === id)?.id ?? "archipelago") as PageId;
}

export function usePage(): PageId {
  const [page, setPage] = useState<PageId>(read);
  useEffect(() => {
    const onHash = () => setPage(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return page;
}

export const href = (id: PageId) => `#/${id}`;
