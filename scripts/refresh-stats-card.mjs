#!/usr/bin/env node
/**
 * Generates static GitHub stats cards (SVG) for the profile README.
 *
 * Two cards are written to assets/ — one for dark mode and one for light:
 *   assets/stats-card-dark.svg
 *   assets/stats-card-light.svg
 * The README shows them adaptively via a <picture> block with
 * prefers-color-scheme. Because the SVGs are committed to the repo, they
 * never depend on a third-party rendering service (unlike
 * github-readme-stats.vercel.app, which has been down as 503).
 *
 * Data comes straight from the GitHub API:
 *   - total stars    (sum of stargazers_count across public repos)
 *   - repositories   (public_repos)
 *   - followers / following
 *   - external merged PRs  (GraphQL, public repos, same rule as facts)
 *   - member since   (created_at year)
 *
 * Idempotent: files are rewritten only when the rendered SVG differs, so the
 * calling workflow can skip the commit via `git diff`. Always exits 0.
 *
 * Run locally with:
 *     GITHUB_TOKEN=... node scripts/refresh-stats-card.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, "..", "assets");

const USER = "vianbas";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const GH_API = "https://api.github.com";
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "vianbas-profile-stats-card",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function gh(path) {
  const res = await fetch(`${GH_API}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

/** Sum of stars across all public repos (paginated). */
async function totalStars() {
  let stars = 0;
  let page = 1;
  for (;;) {
    const repos = await gh(`/users/${USER}/repos?per_page=100&page=${page}`);
    for (const repo of repos) stars += repo.stargazers_count;
    if (repos.length < 100) break;
    page++;
  }
  return stars;
}

/** External merged PRs into PUBLIC repos not owned by USER (GraphQL). */
async function countExternalMergedPRs() {
  let external = 0;
  let cursor = null;
  for (let pages = 0; pages < 20; pages++) {
    const query = `query($login:String!,$cursor:String){
      user(login:$login){
        pullRequests(states: MERGED, first: 100, after: $cursor){
          pageInfo{ hasNextPage endCursor }
          nodes{
            repository{ owner{ login } isPrivate }
          }
        }
      }
    }`;
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
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

const [user, stars, externalPrs] = await Promise.all([
  gh(`/users/${USER}`),
  totalStars(),
  countExternalMergedPRs(),
]);

const stats = [
  { label: "Total Stars", value: String(stars) },
  { label: "Repositories", value: String(user.public_repos) },
  { label: "Followers", value: String(user.followers) },
  { label: "Following", value: String(user.following) },
  { label: "External PRs merged", value: String(externalPrs) },
  { label: "Member since", value: String(new Date(user.created_at).getUTCFullYear()) },
];

/**
 * SVG dimensions: 400×272. Rows start below the title and divider.
 * Each row: colored dot accent + label (left) + value (right-aligned).
 */
function renderCard(theme) {
  const c = theme;
  const rowGap = 30;
  const rowsTop = 66;
  const rows = stats
    .map(
      (s, i) => `
  <circle cx="18" cy="${rowsTop + i * rowGap - 4}" r="3" fill="${c.accent}" />
  <text x="34" y="${rowsTop + i * rowGap}" font-family="'Segoe UI', -apple-system, Ubuntu, sans-serif" font-size="14" fill="${c.label}">${s.label}</text>
  <text x="382" y="${rowsTop + i * rowGap}" font-family="'Segoe UI', -apple-system, Ubuntu, sans-serif" font-size="14" font-weight="700" fill="${c.value}" text-anchor="end">${s.value}</text>`,
    )
    .join("\n");

  const footerY = rowsTop + stats.length * rowGap + 12;

  return `<svg width="400" height="272" viewBox="0 0 400 272" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="0.5" y="0.5" width="399" height="271" rx="12" fill="${c.bg}" stroke="${c.border}" />
  <text x="18" y="30" font-family="'Segoe UI', -apple-system, Ubuntu, sans-serif" font-size="16" font-weight="700" fill="${c.title}">GitHub Stats</text>
  <rect x="18" y="42" width="364" height="1.5" fill="${c.divider}" />
${rows}
  <text x="18" y="${footerY}" font-family="'Segoe UI', -apple-system, Ubuntu, sans-serif" font-size="10" fill="${c.footer}">auto-generated via GitHub Actions</text>
</svg>
`;
}

const themes = {
  dark: {
    bg: "#0D1117",
    border: "#30363D",
    divider: "#21262D",
    title: "#E6EDF3",
    label: "#8B949E",
    value: "#58A6FF",
    accent: "#58A6FF",
    footer: "#484F58",
  },
  light: {
    bg: "#FFFFFF",
    border: "#D0D7DE",
    divider: "#D0D7DE",
    title: "#1F2328",
    label: "#57606A",
    value: "#0969DA",
    accent: "#0969DA",
    footer: "#6E7781",
  },
};

mkdirSync(ASSETS, { recursive: true });
let changed = false;

for (const [mode, theme] of Object.entries(themes)) {
  const file = join(ASSETS, `stats-card-${mode}.svg`);
  const next = renderCard(theme);
  let prev = "";
  try {
    prev = readFileSync(file, "utf8");
  } catch {
    /* first run — file doesn't exist yet */
  }
  if (next.trim() !== prev.trim()) {
    writeFileSync(file, next);
    console.log(`stats-card-${mode}.svg updated.`);
    changed = true;
  } else {
    console.log(`stats-card-${mode}.svg unchanged.`);
  }
}

if (changed) console.log(`Cards generated: ${JSON.stringify(stats)}`);
