#!/usr/bin/env npx tsx
/**
 * Test script: GitHub PR Tracker agent
 *
 * 1. Fetch all open PRs by tysoncung via gh CLI
 * 2. Get review/CI details for each PR
 * 3. Sync to Notion "GitHub PR Tracker" database
 * 4. Flag PRs that need attention
 */

import { Client } from "@notionhq/client";
import { execSync } from "child_process";

// ── Config ─────────────────────────────────────────────────────────────────

const NOTION_API_KEY = process.env.NOTION_API_KEY!;
const DATABASE_ID = "31c4214c-ba08-815c-93cb-cea874bbc63f";
const AUTHOR = "tysoncung";

if (!NOTION_API_KEY) throw new Error("Missing NOTION_API_KEY");

const notion = new Client({ auth: NOTION_API_KEY });

// ── Types ──────────────────────────────────────────────────────────────────

interface PRSummary {
  number: number;
  title: string;
  repo: string;
  url: string;
  updatedAt: string;
  createdAt: string;
}

interface PRDetails {
  reviewDecision: string;
  reviews: Array<{ author: { login: string }; state: string }>;
  statusCheckRollup: Array<{ name: string; status: string; conclusion: string }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function richText(text: string) {
  return [{ type: "text" as const, text: { content: text } }];
}

function ghJson<T>(cmd: string): T {
  const output = execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(output) as T;
}

function fetchOpenPRs(): PRSummary[] {
  const raw = ghJson<any[]>(
    `gh search prs --author ${AUTHOR} --state open --json repository,title,url,createdAt,updatedAt,number --limit 100`
  );
  return raw.map((pr) => ({
    number: pr.number,
    title: pr.title,
    repo: pr.repository.nameWithOwner,
    url: pr.url,
    updatedAt: pr.updatedAt,
    createdAt: pr.createdAt,
  }));
}

function fetchPRDetails(repo: string, number: number): PRDetails {
  try {
    return ghJson<PRDetails>(
      `gh pr view ${number} --repo ${repo} --json reviewDecision,reviews,statusCheckRollup`
    );
  } catch {
    return { reviewDecision: "", reviews: [], statusCheckRollup: [] };
  }
}

function deriveStatus(reviewDecision: string): string {
  switch (reviewDecision) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes Requested";
    default:
      return "Open";
  }
}

function deriveCI(checks: PRDetails["statusCheckRollup"]): string {
  if (!checks || checks.length === 0) return "None";
  const hasFailure = checks.some(
    (c) => c.conclusion === "FAILURE" || c.conclusion === "ERROR" || c.conclusion === "ACTION_REQUIRED"
  );
  if (hasFailure) return "Failing";
  const allDone = checks.every(
    (c) => c.status === "COMPLETED" && (c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED")
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
  // No activity in 7+ days
  const daysSinceUpdate =
    (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate >= 7) return true;
  return false;
}

// ── Notion sync ────────────────────────────────────────────────────────────

async function findExistingPage(url: string): Promise<string | null> {
  const result = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: { property: "URL", url: { equals: url } },
    page_size: 1,
  });
  return result.results.length > 0 ? result.results[0].id : null;
}

async function syncPR(pr: PRSummary, details: PRDetails) {
  const status = deriveStatus(details.reviewDecision);
  const ci = deriveCI(details.statusCheckRollup);
  const reviewCount = details.reviews?.length ?? 0;
  const attention = needsAttention(status, ci, pr.updatedAt);

  const properties: Record<string, any> = {
    PR: { title: richText(`#${pr.number} ${pr.title}`) },
    Repo: { select: { name: pr.repo } },
    Status: { select: { name: status } },
    CI: { select: { name: ci } },
    Reviews: { number: reviewCount },
    URL: { url: pr.url },
    Updated: { date: { start: pr.updatedAt } },
    "Needs Attention": { checkbox: attention },
  };

  const existingId = await findExistingPage(pr.url);

  if (existingId) {
    await notion.pages.update({ page_id: existingId, properties });
    return { action: "updated" as const, attention };
  } else {
    await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties,
    });
    return { action: "created" as const, attention };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🔀 GitHub PR Tracker — syncing open PRs by @${AUTHOR}`);
  console.log("");

  // 1. Fetch all open PRs
  console.log("📡 Fetching open PRs...");
  const prs = fetchOpenPRs();
  console.log(`   Found ${prs.length} open PRs`);
  console.log("");

  // 2. Sync each PR
  let synced = 0;
  let attentionCount = 0;
  const errors: string[] = [];

  for (const pr of prs) {
    process.stdout.write(`  ⏳ #${pr.number} ${pr.repo} — ${pr.title.slice(0, 50)}...`);

    try {
      const details = fetchPRDetails(pr.repo, pr.number);
      const result = await syncPR(pr, details);
      synced++;
      if (result.attention) attentionCount++;
      console.log(` ✅ ${result.action}${result.attention ? " ⚠️" : ""}`);
    } catch (err: any) {
      errors.push(`#${pr.number}: ${err.message}`);
      console.log(` ❌ ${err.message.slice(0, 60)}`);
    }

    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 200));
  }

  // 3. Summary
  console.log("");
  console.log("═══════════════════════════════════════════════");
  console.log("  GITHUB PR TRACKER SYNC COMPLETE");
  console.log(`  PRs synced: ${synced}/${prs.length}`);
  console.log(`  Need attention: ${attentionCount}`);
  if (errors.length > 0) {
    console.log(`  Errors: ${errors.length}`);
    errors.forEach((e) => console.log(`    - ${e}`));
  }
  console.log(`  Database: https://www.notion.so/${DATABASE_ID.replace(/-/g, "")}`);
  console.log("═══════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
