#!/usr/bin/env node
/**
 * Refreshes the GitHub facts badge row in the profile README from the GitHub API.
 *
 * Facts updated:
 *   - repositories   (users API → public_repos)
 *   - merged PRs     (GraphQL, into public repos not owned by USER)
 *   - member since   (users API → created_at year)
 *
 * These render as static shields.io badges whose values are baked into the
 * URL. That matters: a shields *endpoint* badge keeps one fixed URL, so
 * GitHub's camo proxy can serve a stale image long after the number changes.
 * Baking the value into the URL changes the URL whenever the number does,
 * which busts the cache and shows the new value immediately.
 *
 * The badge row between the `facts:start` / `facts:end` markers is rewritten
 * in place; when nothing changed the README is left untouched so the calling
 * workflow can detect that via `git diff` and skip the commit. Always exits 0.
 * Run locally with:
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
 * Count merged PRs authored by USER into PUBLIC repositories NOT owned by USER.
 *
 * Uses the GraphQL `User.pullRequests(states: MERGED)` connection — the PRs
 * authored by the user, read directly from the database (not the search
 * index). The search REST API is eventually consistent: item enumeration
 * returned 1, 2, or 4 across runs, and even `total_count` subtraction gave a
 * different result in CI than locally. GraphQL paginates the authoritative
 * connection and is stable across runs and environments.
 *
 * Only PUBLIC repositories count. The GITHUB_TOKEN installation token used in
 * CI cannot see PRs into private repositories, while a personal access token
 * can — so filtering to public repos makes the result deterministic no matter
 * which token runs the workflow, and it stays verifiable by profile visitors.
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
          nodes{
            repository{ owner{ login } isPrivate }
          }
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
      const repo = node.repository;
      if (repo.owner.login !== USER && repo.isPrivate !== true) external++;
    }
    if (!pr.pageInfo.hasNextPage) break;
    cursor = pr.pageInfo.endCursor;
  }
  return external;
}

/**
 * shields.io path-form escaping: `-` doubles, `_` doubles, spaces become %20.
 * Applied before the value goes into the badge URL.
 */
function badgeSegment(text) {
  return String(text).replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "%20");
}

const BADGE_COLOR = "0A66C2";

function badge(label, message) {
  const alt = label.replace(/]/g, "");
  return `![${alt}](https://img.shields.io/badge/${badgeSegment(label)}-${badgeSegment(message)}-${BADGE_COLOR}?style=flat-square)`;
}

const [user, externalMerged] = await Promise.all([
  gh(`/users/${USER}`),
  countExternalMergedPRs(),
]);

const facts = {
  repositories: String(user.public_repos),
  "merged PRs": String(externalMerged),
  "member since": String(new Date(user.created_at).getUTCFullYear()),
};

let readme = readFileSync(README, "utf8");
let changed = false;

const START = "<!-- facts:start -->";
const END = "<!-- facts:end -->";
const block = new RegExp(`${START}\\n[\\s\\S]*?\\n${END}`, "u");

const row = Object.entries(facts)
  .map(([label, value]) => badge(label, value))
  .join("\n");
const replacement = `${START}\n${row}\n${END}`;

if (block.test(readme)) {
  const next = readme.replace(block, replacement);
  if (next !== readme) {
    readme = next;
    changed = true;
  }
} else {
  console.warn(`Facts markers not found — README left untouched.`);
}

if (changed) {
  writeFileSync(README, readme);
  console.log(`README facts updated: ${JSON.stringify(facts)}`);
} else {
  console.log("No facts rows changed.");
}
