/**
 * GitHub Tracker Agent — Monitors GitHub PRs and syncs status to a Notion database.
 *
 * Expected Notion database schema:
 *   - Name (title): PR title
 *   - Status (select): open | closed | merged
 *   - PR Number (number): GitHub PR number
 *   - Author (rich_text): PR author
 *   - URL (url): GitHub PR URL
 *   - Repository (rich_text): owner/repo
 *   - Updated (date): Last updated time
 */

import { getNotionClient, plainToRichText } from "../utils/notion-client.js";
import { notionQuery } from "../tools/notion-query.js";
import { logger } from "../utils/logger.js";
import type { Task } from "../queue/task-queue.js";

export interface GitHubTrackerInput {
  repo: string;            // owner/repo format
  database_id: string;     // Notion database to sync to
  state?: "open" | "closed" | "all";
}

interface GitHubPR {
  number: number;
  title: string;
  state: string;
  user: { login: string };
  html_url: string;
  updated_at: string;
  merged_at: string | null;
}

/**
 * Fetch PRs from GitHub API (no auth required for public repos).
 */
async function fetchGitHubPRs(repo: string, state = "open"): Promise<GitHubPR[]> {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/pulls?state=${state}&per_page=30&sort=updated&direction=desc`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "notion-agent-hub",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GitHubPR[];
}

/**
 * Sync a single PR to the Notion database.
 */
async function syncPRToNotion(pr: GitHubPR, databaseId: string, repo: string) {
  const notion = getNotionClient();

  // Check if PR already exists in the database
  const existing = await notionQuery({
    database_id: databaseId,
    filter: {
      property: "PR Number",
      number: { equals: pr.number },
    },
    page_size: 1,
  });

  const status = pr.merged_at ? "merged" : pr.state;
  const properties: Record<string, any> = {
    Name: { title: plainToRichText(pr.title) },
    Status: { select: { name: status } },
    "PR Number": { number: pr.number },
    Author: { rich_text: plainToRichText(pr.user.login) },
    URL: { url: pr.html_url },
    Repository: { rich_text: plainToRichText(repo) },
    Updated: { date: { start: pr.updated_at } },
  };

  if (existing.results.length > 0) {
    // Update existing page
    await notion.pages.update({
      page_id: existing.results[0].id,
      properties,
    });
    logger.info("Updated PR in Notion", { pr: pr.number, status });
  } else {
    // Create new page
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });
    logger.info("Created PR in Notion", { pr: pr.number, status });
  }
}

/**
 * Run the GitHub tracker agent workflow.
 */
export async function runGitHubTracker(input: GitHubTrackerInput) {
  logger.info("Starting GitHub tracker", { repo: input.repo });

  const prs = await fetchGitHubPRs(input.repo, input.state ?? "open");
  logger.info("Fetched PRs", { count: prs.length });

  let synced = 0;
  for (const pr of prs) {
    try {
      await syncPRToNotion(pr, input.database_id, input.repo);
      synced++;
    } catch (err: any) {
      logger.error("Failed to sync PR", { pr: pr.number, error: err.message });
    }
  }

  return {
    repo: input.repo,
    total_prs: prs.length,
    synced,
  };
}

/**
 * Task queue handler for GitHub tracker tasks.
 */
export async function handleGitHubTrackerTask(task: Task) {
  const input = task.input as GitHubTrackerInput;

  if (!input.repo) {
    throw new Error("GitHub tracker task requires a 'repo' in input");
  }
  if (!input.database_id) {
    throw new Error("GitHub tracker task requires a 'database_id' in input");
  }

  return runGitHubTracker(input);
}
