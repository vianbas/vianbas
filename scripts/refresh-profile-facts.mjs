#!/usr/bin/env node
/**
 * Refreshes the GitHub facts table in the profile README from the GitHub API.
 *
 * Facts updated:
 *   - 💻 Public repositories   (users API → public_repos)
 *   - 👥 Followers            (users API → followers)
 *   - 🚀 PRs merged into external repos  (search API, minus vianbas/*)
 *   - 📅 GitHub member since  (users API → created_at year)
 *
 * The table is rewritten in place; when nothing changed the README is left
 * untouched so the calling workflow can detect that via `git diff` and skip
 * the commit. Always exits 0. Run locally with:
 *     GITHUB_TOKEN=... node scripts/refresh-profile-facts.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const README = join(__dirname, "..", "README.md");

const GH_API = "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const USER = "vianbas";

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "vianbas-profile-facts-refresh",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

/** GET a JSON endpoint, throwing on non-2xx. */
async function gh(path) {
  const res = await fetch(`${GH_API}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Count merged PRs authored by USER into repositories NOT owned by USER.
 *
 * Uses the GraphQL `User.pullRequests(states: MERGED)` connection — the PRs
 * authored by the user, read directly from the database (not the search
 * index). The search REST API is eventually consistent: item enumeration
 * returned 1, 2, or 4 across runs, and even `total_count` subtraction gave a
 * different result in CI than locally. GraphQL paginates the authoritative
 * connection and is stable across runs and environments.
 */
async function countExternalMergedPRs() {
  let external = 0;
  let cursor = null;
  for (let pages = 0; pages < 20; pages++) {
    const query = `query($login:String!,$cursor:String){
      user(login:$login){
        pullRequests(states: MERGED, first: 100, after: $cursor){
          totalCount
          pageInfo{ hasNextPage endCursor }
          nodes{ repository{ owner{ login } } }
        }
      }
    }`;
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "vianbas-profile-facts-refresh",
      },
      body: JSON.stringify({ query, variables: { login: USER, cursor } }),
    });
    if (!res.ok) throw new Error(`GraphQL → HTTP ${res.status}`);
    const json = await res.json();
    const pr = json?.data?.user?.pullRequests;
    if (!pr) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
    for (const node of pr.nodes) {
      if (node.repository.owner.login !== USER) external++;
    }
    if (!pr.pageInfo.hasNextPage) break;
    cursor = pr.pageInfo.endCursor;
  }
  return external;
}

const [user, externalMerged] = await Promise.all([
  gh(`/users/${USER}`),
  countExternalMergedPRs(),
]);

const facts = {
  "💻 Public repositories": String(user.public_repos),
  "👥 Followers": String(user.followers),
  "🚀 PRs merged into external repos": String(externalMerged),
  "📅 GitHub member since": String(new Date(user.created_at).getUTCFullYear()),
};

let readme = readFileSync(README, "utf8");
let changed = false;

for (const [label, value] of Object.entries(facts)) {
  // Match `| 💻 Public repositories | 40 |` and replace the number cell.
  const row = new RegExp(`(\\| ${label} \\| )\\d+( \\|)`, "u");
  if (row.test(readme)) {
    readme = readme.replace(row, `$1${value}$2`);
    changed = true;
  } else {
    console.warn(`Facts row not found (skipped): ${label}`);
  }
}

if (changed) {
  writeFileSync(README, readme);
  console.log(`README facts updated: ${JSON.stringify(facts)}`);
} else {
  console.log("No facts rows changed.");
}
