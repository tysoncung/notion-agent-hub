/**
 * GitHub Tracker Agent — Monitors GitHub PRs and syncs status to a Notion database.
 *
 * Notion database schema:
 *   - PR (title): PR number and title
 *   - Repo (select): repository name
 *   - Status (select): Open, Merged, Closed, Changes Requested, Approved
 *   - CI (select): Passing, Failing, Pending, None
 *   - Reviews (number): number of reviews
 *   - URL (url): GitHub PR URL
 *   - Updated (date): last updated time
 *   - Needs Attention (checkbox): flagged if action needed
 */

import { getNotionClient, plainToRichText } from "../utils/notion-client.js";
import { logger } from "../utils/logger.js";
import type { Task } from "../queue/task-queue.js";

export interface GitHubTrackerInput {
  author: string;
  database_id: string;
  github_token?: string;
  state?: "open" | "closed" | "all";
}

interface GitHubSearchPR {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
  created_at: string;
  user: { login: string };
  base: { repo: { full_name: string } };
}

interface GitHubReview {
  user: { login: string };
  state: string;
}

interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

// ── GitHub API helpers ─────────────────────────────────────────────────────

async function githubFetch<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "notion-agent-hub",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText} — ${url}`);
  }
  return (await res.json()) as T;
}

async function fetchOpenPRsByAuthor(
  author: string,
  token?: string,
  state = "open"
): Promise<GitHubSearchPR[]> {
  const q = encodeURIComponent(`type:pr author:${author} state:${state}`);
  const data = await githubFetch<{ items: GitHubSearchPR[] }>(
    `https://api.github.com/search/issues?q=${q}&per_page=100&sort=updated&order=desc`,
    token
  );
  return data.items;
}

async function fetchPRReviews(
  repo: string,
  prNumber: number,
  token?: string
): Promise<GitHubReview[]> {
  try {
    return await githubFetch<GitHubReview[]>(
      `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`,
      token
    );
  } catch {
    return [];
  }
}

async function fetchPRChecks(
  repo: string,
  prNumber: number,
  token?: string
): Promise<GitHubCheckRun[]> {
  try {
    // Get the PR to find the head SHA
    const pr = await githubFetch<{ head: { sha: string } }>(
      `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
      token
    );
    const data = await githubFetch<{ check_runs: GitHubCheckRun[] }>(
      `https://api.github.com/repos/${repo}/commits/${pr.head.sha}/check-runs`,
      token
    );
    return data.check_runs ?? [];
  } catch {
    return [];
  }
}

// ── Status derivation ──────────────────────────────────────────────────────

function deriveStatus(reviews: GitHubReview[]): string {
  if (reviews.length === 0) return "Open";
  // Check the latest unique reviewer decisions
  const latestByReviewer = new Map<string, string>();
  for (const r of reviews) {
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") {
      latestByReviewer.set(r.user.login, r.state);
    }
  }
  const decisions = [...latestByReviewer.values()];
  if (decisions.includes("CHANGES_REQUESTED")) return "Changes Requested";
  if (decisions.includes("APPROVED")) return "Approved";
  return "Open";
}

function deriveCI(checks: GitHubCheckRun[]): string {
  if (!checks || checks.length === 0) return "None";
  const hasFailure = checks.some(
    (c) =>
      c.conclusion === "failure" ||
      c.conclusion === "error" ||
      c.conclusion === "action_required"
  );
  if (hasFailure) return "Failing";
  const allDone = checks.every(
    (c) =>
      c.status === "completed" &&
      (c.conclusion === "success" ||
        c.conclusion === "neutral" ||
        c.conclusion === "skipped")
  );
  if (allDone) return "Passing";
  return "Pending";
}

function needsAttention(
  status: string,
  ci: string,
  updatedAt: string
): boolean {
  if (status === "Changes Requested") return true;
  if (ci === "Failing") return true;
  const daysSinceUpdate =
    (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceUpdate >= 7;
}

// ── Notion sync ────────────────────────────────────────────────────────────

async function findExistingPage(
  databaseId: string,
  url: string
): Promise<string | null> {
  const notion = getNotionClient();
  const result = await notion.databases.query({
    database_id: databaseId,
    filter: { property: "URL", url: { equals: url } },
    page_size: 1,
  });
  return result.results.length > 0 ? result.results[0].id : null;
}

async function syncPRToNotion(
  databaseId: string,
  pr: {
    number: number;
    title: string;
    repo: string;
    url: string;
    updatedAt: string;
  },
  reviews: GitHubReview[],
  checks: GitHubCheckRun[]
) {
  const notion = getNotionClient();
  const status = deriveStatus(reviews);
  const ci = deriveCI(checks);
  const attention = needsAttention(status, ci, pr.updatedAt);

  const properties: Record<string, any> = {
    PR: { title: plainToRichText(`#${pr.number} ${pr.title}`) },
    Repo: { select: { name: pr.repo } },
    Status: { select: { name: status } },
    CI: { select: { name: ci } },
    Reviews: { number: reviews.length },
    URL: { url: pr.url },
    Updated: { date: { start: pr.updatedAt } },
    "Needs Attention": { checkbox: attention },
  };

  const existingId = await findExistingPage(databaseId, pr.url);

  if (existingId) {
    await notion.pages.update({ page_id: existingId, properties });
    logger.info("Updated PR in Notion", {
      pr: pr.number,
      status,
      ci,
      attention,
    });
    return { action: "updated" as const, attention };
  } else {
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });
    logger.info("Created PR in Notion", {
      pr: pr.number,
      status,
      ci,
      attention,
    });
    return { action: "created" as const, attention };
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run the GitHub tracker agent workflow.
 */
export async function runGitHubTracker(input: GitHubTrackerInput) {
  const token = input.github_token ?? process.env.GH_TOKEN;
  logger.info("Starting GitHub tracker", { author: input.author });

  const prs = await fetchOpenPRsByAuthor(input.author, token, input.state ?? "open");
  logger.info("Fetched PRs from GitHub", { count: prs.length });

  let synced = 0;
  let attentionCount = 0;

  for (const pr of prs) {
    try {
      const repo =
        pr.base?.repo?.full_name ??
        pr.html_url.replace("https://github.com/", "").split("/pull/")[0];
      const reviews = await fetchPRReviews(repo, pr.number, token);
      const checks = await fetchPRChecks(repo, pr.number, token);

      const result = await syncPRToNotion(input.database_id, {
        number: pr.number,
        title: pr.title,
        repo,
        url: pr.html_url,
        updatedAt: pr.updated_at,
      }, reviews, checks);

      synced++;
      if (result.attention) attentionCount++;
    } catch (err: any) {
      logger.error("Failed to sync PR", {
        pr: pr.number,
        error: err.message,
      });
    }
  }

  return {
    author: input.author,
    total_prs: prs.length,
    synced,
    needs_attention: attentionCount,
  };
}

/**
 * Task queue handler for GitHub tracker tasks.
 */
export async function handleGitHubTrackerTask(task: Task) {
  const input = task.input as GitHubTrackerInput;

  if (!input.author) {
    throw new Error("GitHub tracker task requires an 'author' in input");
  }
  if (!input.database_id) {
    throw new Error("GitHub tracker task requires a 'database_id' in input");
  }

  return runGitHubTracker(input);
}
