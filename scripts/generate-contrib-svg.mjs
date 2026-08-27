#!/usr/bin/env node
/**
 * Renders the contribution calendar as an animated "security scan" SVG.
 *
 * A sweep passes left-to-right across the year grid, brightening each column
 * as it goes, with a side panel reporting streaks and totals. Two files are
 * written — dark and light — so the README can pick one via <picture>.
 *
 * Env:
 *   GH_USERNAME       account to render (default: vianbas)
 *   GITHUB_TOKEN      token with read access; required unless CONTRIB_FIXTURE is set
 *   OUTPUT_DIR        directory for the generated SVGs (default: assets)
 *   CONTRIB_FIXTURE   path to a saved GraphQL response, used instead of the API
 */

import fs from "node:fs";
import path from "node:path";

export const USERNAME = process.env.GH_USERNAME || "vianbas";
export const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
export const OUTPUT_DIR = process.env.OUTPUT_DIR || "assets";
export const FIXTURE = process.env.CONTRIB_FIXTURE || "";

// ---------------------------------------------------------------- geometry

const CELL = 11;
const GAP = 3;
const PITCH = CELL + GAP;
const ROWS = 7;

const PAD = 26;
const DAY_LABEL_W = 30;
const HEADER_H = 34;
const MONTH_H = 18;

const GRID_X = PAD + DAY_LABEL_W;
const GRID_Y = PAD + HEADER_H + MONTH_H;
const GRID_H = ROWS * PITCH - GAP;

const PANEL_GAP = 34;
const PANEL_W = 252;
const PANEL_Y = PAD + HEADER_H;

const SWEEP_DUR = 5; // seconds for one full pass
const BAND_W = 240; // width of the brightening band

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

// ------------------------------------------------------------------ themes

export const THEMES = {
  dark: {
    bg: "#0D1117",
    border: "#21262D",
    panelBg: "#010409",
    text: "#E6EDF3",
    dim: "#7D8590",
    accent: "#58A6FF",
    ok: "#3FB950",
    levels: ["#161B22", "#0E3A6B", "#14589E", "#2B7FD4", "#58A6FF"],
    hot: ["#161B22", "#1E5FA8", "#3B8FE0", "#6FB8FF", "#A6D5FF"],
    scan: "#58A6FF",
    scanOpacity: 0.9,
  },
  light: {
    bg: "#FFFFFF",
    border: "#D0D7DE",
    panelBg: "#F6F8FA",
    text: "#1F2328",
    dim: "#656D76",
    accent: "#0A66C2",
    ok: "#1A7F37",
    levels: ["#EBEDF0", "#C6DCF5", "#7FB0E8", "#3C82D2", "#0A66C2"],
    hot: ["#E1E7EE", "#A9C9EF", "#5A97DF", "#1F6BC4", "#054E97"],
    scan: "#0A66C2",
    scanOpacity: 0.75,
  },
};

// -------------------------------------------------------------------- data

export function flattenDays(calendar) {
  const days = [];
  for (const week of calendar.weeks) {
    for (const day of week.contributionDays) {
      days.push({ date: day.date, count: day.contributionCount });
    }
  }
  return days;
}

/** GitHub-style buckets: quartiles over the non-zero days, so a few huge days
 *  don't flatten the rest of the year into level 1. */
export function thresholds(days) {
  const nonZero = days.map((d) => d.count).filter((c) => c > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return [1, 2, 3];
  const at = (p) => nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * p))];
  return [at(0.25), at(0.5), at(0.75)];
}

export function levelOf(count, [q1, q2, q3]) {
  if (count <= 0) return 0;
  if (count <= q1) return 1;
  if (count <= q2) return 2;
  if (count <= q3) return 3;
  return 4;
}

export function streaks(days) {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.count > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }

  // Walk back from the end. Today being empty doesn't break the streak yet.
  let current = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i -= 1;
  for (; i >= 0 && days[i].count > 0; i -= 1) current += 1;

  return { current, longest };
}

export function summarise(calendar) {
  const days = flattenDays(calendar);
  const active = days.filter((d) => d.count > 0).length;
  const busiest = days.reduce((best, d) => (d.count > best.count ? d : best), { date: "", count: 0 });
  return {
    days,
    total: calendar.totalContributions,
    active,
    tracked: days.length,
    busiest,
    ...streaks(days),
  };
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from, to) {
  const day = 86400000;
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / day));
}

export function agoLabel(from, to) {
  const days = daysBetween(from, to);
  if (days === 0) return "TODAY";
  if (days === 1) return "YESTERDAY";
  return `${days}D AGO`;
}

export function shortDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ------------------------------------------------------------------- fetch

const QUERY = `query($login:String!){
  user(login:$login){
    contributionsCollection{
      contributionCalendar{
        totalContributions
        weeks{ contributionDays{ date contributionCount } }
      }
    }
  }
}`;

/**
 * The public, non-fork repository this user pushed to most recently.
 *
 * The profile repository itself is skipped: the daily refresh workflow commits
 * to it, so it would otherwise always win and the card would forever read
 * "now building: <username>".
 */
export async function fetchLatestRepo(login, token) {
  const res = await fetch(
    `https://api.github.com/users/${login}/repos?sort=pushed&direction=desc&type=owner&per_page=30`,
    {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "application/vnd.github+json",
        "User-Agent": `${login}-contrib-svg`,
      },
    },
  );
  if (!res.ok) throw new Error(`GitHub API responded ${res.status} ${res.statusText}`);
  const repos = await res.json();
  const repo = repos.find((r) => !r.fork && !r.private && r.name !== login);
  return repo ? { name: repo.name, pushedAt: repo.pushed_at.slice(0, 10) } : null;
}

export async function fetchCalendar(login, token) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": `${login}-contrib-svg`,
    },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data.user.contributionsCollection.contributionCalendar;
}

// ------------------------------------------------------------------ render

/** Clip over-long text so it cannot overflow the report panel. */
export function truncate(text, max) {
  const value = String(text);
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;
}

export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c],
  );
}

function monthLabels(weeks) {
  const labels = [];
  let lastMonth = -1;
  let lastCol = -3;
  weeks.forEach((week, col) => {
    const first = week.contributionDays[0];
    if (!first) return;
    const month = Number(first.date.split("-")[1]) - 1;
    if (month !== lastMonth && col - lastCol >= 3) {
      labels.push({ col, text: MONTHS[month] });
      lastMonth = month;
      lastCol = col;
    }
  });
  return labels;
}

function cells(weeks, cuts, palette) {
  const out = [];
  weeks.forEach((week, col) => {
    week.contributionDays.forEach((day) => {
      const row = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      const x = GRID_X + col * PITCH;
      const y = GRID_Y + row * PITCH;
      const fill = palette[levelOf(day.contributionCount, cuts)];
      out.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2.5" fill="${fill}"/>`);
    });
  });
  return out.join("\n      ");
}

function statRow(theme, x, y, label, value, size = 15) {
  return `
    <text x="${x}" y="${y}" font-family="${MONO}" font-size="10" letter-spacing="1.2" fill="${theme.dim}">${escapeXml(label)}</text>
    <text x="${x}" y="${y + 17}" font-family="${MONO}" font-size="${size}" font-weight="600" fill="${theme.text}">${escapeXml(value)}</text>`;
}

export function renderSvg(calendar, themeName, latest = null) {
  const theme = THEMES[themeName];
  if (!theme) throw new Error(`Unknown theme: ${themeName}`);

  const weeks = calendar.weeks;
  const cols = weeks.length;
  const gridW = cols * PITCH - GAP;
  const panelX = GRID_X + gridW + PANEL_GAP;
  const width = panelX + PANEL_W + PAD;
  const height = 262;
  const panelH = height - PANEL_Y - PAD;
  const legendY = GRID_Y + GRID_H + 28;

  const stats = summarise(calendar);
  const cuts = thresholds(stats.days);
  const lastDay = stats.days.length ? stats.days[stats.days.length - 1].date : "";

  const base = cells(weeks, cuts, theme.levels);
  const hot = cells(weeks, cuts, theme.hot);
  const months = monthLabels(weeks)
    .map(
      (m) =>
        `<text x="${GRID_X + m.col * PITCH}" y="${GRID_Y - 8}" font-family="${MONO}" font-size="10" fill="${theme.dim}">${m.text}</text>`,
    )
    .join("\n      ");

  const dayNames = [
    [1, "Mon"],
    [3, "Wed"],
    [5, "Fri"],
  ]
    .map(
      ([row, name]) =>
        `<text x="${GRID_X - 10}" y="${GRID_Y + row * PITCH + CELL - 2}" text-anchor="end" font-family="${MONO}" font-size="10" fill="${theme.dim}">${name}</text>`,
    )
    .join("\n      ");

  const legend = theme.levels
    .map(
      (fill, i) =>
        `<rect x="${GRID_X + 44 + i * (CELL + 4)}" y="${legendY - 9}" width="${CELL}" height="${CELL}" rx="2.5" fill="${fill}"/>`,
    )
    .join("\n      ");

  const prompt = `${USERNAME}@github ~ $ ./contrib-scan --window 365d`;
  const sx = panelX + 20;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(USERNAME)} contribution scan: ${stats.total} contributions in the last year">
  <defs>
    <linearGradient id="band" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000000"/>
      <stop offset="0.34" stop-color="#000000"/>
      <stop offset="0.5" stop-color="#FFFFFF"/>
      <stop offset="0.66" stop-color="#000000"/>
      <stop offset="1" stop-color="#000000"/>
    </linearGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${theme.scan}" stop-opacity="0"/>
      <stop offset="0.5" stop-color="${theme.scan}" stop-opacity="${theme.scanOpacity}"/>
      <stop offset="1" stop-color="${theme.scan}" stop-opacity="0"/>
    </linearGradient>
    <mask id="sweep" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#000000"/>
      <g>
        <rect x="0" y="0" width="${BAND_W}" height="${height}" fill="url(#band)"/>
        <animateTransform attributeName="transform" type="translate"
          from="${GRID_X - BAND_W} 0" to="${GRID_X + gridW} 0"
          dur="${SWEEP_DUR}s" repeatCount="indefinite"/>
      </g>
    </mask>
    <clipPath id="gridArea">
      <rect x="${GRID_X - 2}" y="${GRID_Y - 4}" width="${gridW + 4}" height="${GRID_H + 8}"/>
    </clipPath>
  </defs>

  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${theme.bg}" stroke="${theme.border}"/>

  <g>
    <circle cx="${PAD + 5}" cy="${PAD + 8}" r="5" fill="#FF5F57"/>
    <circle cx="${PAD + 21}" cy="${PAD + 8}" r="5" fill="#FEBC2E"/>
    <circle cx="${PAD + 37}" cy="${PAD + 8}" r="5" fill="#28C840"/>
    <text x="${PAD + 54}" y="${PAD + 12}" font-family="${MONO}" font-size="12" fill="${theme.dim}">${escapeXml(prompt)}</text>
    <rect x="${PAD + 54 + prompt.length * 7.24}" y="${PAD + 2}" width="7" height="13" fill="${theme.accent}">
      <animate attributeName="opacity" values="1;1;0;0" dur="1.1s" repeatCount="indefinite"/>
    </rect>
  </g>

  <g>
      ${months}
      ${dayNames}
  </g>

  <g>
      ${base}
  </g>
  <g mask="url(#sweep)">
      ${hot}
  </g>

  <g clip-path="url(#gridArea)">
    <g>
      <rect x="${BAND_W / 2 - 1}" y="${GRID_Y - 4}" width="2" height="${GRID_H + 8}" fill="url(#beam)"/>
      <animateTransform attributeName="transform" type="translate"
        from="${GRID_X - BAND_W} 0" to="${GRID_X + gridW} 0"
        dur="${SWEEP_DUR}s" repeatCount="indefinite"/>
    </g>
  </g>

  <g>
    <text x="${GRID_X}" y="${legendY}" font-family="${MONO}" font-size="10" fill="${theme.dim}">Less</text>
      ${legend}
    <text x="${GRID_X + 44 + 5 * (CELL + 4) + 4}" y="${legendY}" font-family="${MONO}" font-size="10" fill="${theme.dim}">More</text>
  </g>

  <g>
    <circle cx="${GRID_X + 4}" cy="${legendY + 22}" r="4" fill="${theme.ok}">
      <animate attributeName="opacity" values="1;0.25;1" dur="2.4s" repeatCount="indefinite"/>
    </circle>
    <text x="${GRID_X + 16}" y="${legendY + 26}" font-family="${MONO}" font-size="10" letter-spacing="0.8" fill="${theme.dim}">SCAN OK \u00b7 0 ANOMALIES \u00b7 PEAK ${stats.busiest.count} \u00b7 SYNCED ${escapeXml(shortDate(lastDay))}</text>
  </g>

  <g>
    <rect x="${panelX}.5" y="${PANEL_Y}.5" width="${PANEL_W - 1}" height="${panelH - 1}" rx="8" fill="${theme.panelBg}" stroke="${theme.border}"/>
    <text x="${sx}" y="${PANEL_Y + 22}" font-family="${MONO}" font-size="10" letter-spacing="1.6" fill="${theme.accent}">SCAN REPORT</text>
    <line x1="${sx}" y1="${PANEL_Y + 32}" x2="${panelX + PANEL_W - 20}" y2="${PANEL_Y + 32}" stroke="${theme.border}"/>
    ${statRow(theme, sx, PANEL_Y + 52, "CONTRIBUTIONS", stats.total.toLocaleString("en-US"))}
    ${statRow(theme, sx + 116, PANEL_Y + 52, "ACTIVE DAYS", `${stats.active}`)}
    ${statRow(theme, sx, PANEL_Y + 96, "CURRENT STREAK", `${stats.current} days`)}
    ${statRow(theme, sx + 116, PANEL_Y + 96, "LONGEST", `${stats.longest} days`)}
    ${
      latest
        ? statRow(theme, sx, PANEL_Y + 140, `NOW BUILDING \u00b7 ${agoLabel(latest.pushedAt, lastDay)}`, truncate(latest.name, 26), 13)
        : statRow(theme, sx, PANEL_Y + 140, "BUSIEST DAY", `${stats.busiest.count} \u00b7 ${shortDate(stats.busiest.date)}`)
    }
  </g>
</svg>
`;
}

// -------------------------------------------------------------------- main

export async function main() {
  const calendar = FIXTURE
    ? JSON.parse(fs.readFileSync(FIXTURE, "utf8")).data.user.contributionsCollection.contributionCalendar
    : await (async () => {
        if (!TOKEN) throw new Error("GITHUB_TOKEN is required (or set CONTRIB_FIXTURE)");
        console.log(`Fetching contributions for @${USERNAME}...`);
        return fetchCalendar(USERNAME, TOKEN);
      })();

  let latest = null;
  try {
    latest = await fetchLatestRepo(USERNAME, TOKEN);
    if (latest) console.log(`Latest push: ${latest.name} (${latest.pushedAt})`);
  } catch (err) {
    // Non-fatal: the card falls back to the busiest-day row.
    console.warn(`Could not read latest repo (${err.message}) — falling back.`);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const theme of Object.keys(THEMES)) {
    const file = path.join(OUTPUT_DIR, `contrib-${theme}.svg`);
    fs.writeFileSync(file, renderSvg(calendar, theme, latest), "utf8");
    console.log(`Wrote ${file}`);
  }

}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
