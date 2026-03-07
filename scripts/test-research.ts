#!/usr/bin/env npx tsx
/**
 * Test script: End-to-end research agent
 *
 * 1. Query Notion task queue for "Pending" tasks
 * 2. Claim the first one (set status → Running)
 * 3. Extract topic from task title
 * 4. Search the web via Brave Search API
 * 5. Summarize results with OpenAI
 * 6. Create a Notion results page with structured content
 * 7. Update task Result field + set status → Done
 */

import { Client } from "@notionhq/client";
import OpenAI from "openai";

// ── Config ─────────────────────────────────────────────────────────────────

const NOTION_API_KEY = process.env.NOTION_API_KEY!;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const DATABASE_ID = "31c4214c-ba08-8116-9917-fd1428d45588";

if (!NOTION_API_KEY) throw new Error("Missing NOTION_API_KEY");
if (!BRAVE_API_KEY) throw new Error("Missing BRAVE_API_KEY");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const notion = new Client({ auth: NOTION_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Helpers ────────────────────────────────────────────────────────────────

function richText(text: string) {
  return [{ type: "text" as const, text: { content: text } }];
}

function richTextLinked(text: string, url: string) {
  return [{ type: "text" as const, text: { content: text, link: { url } } }];
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function braveSearch(query: string, count = 10): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(count) });
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
    }
  );
  if (!res.ok) throw new Error(`Brave Search error: ${res.status}`);
  const data: any = await res.json();
  return (data.web?.results ?? []).slice(0, count).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
}

interface StructuredResearch {
  executive_summary: string;
  key_findings: string[];
  best_practices: string[];
  tools_and_frameworks: string[];
  recommendations: string[];
}

async function summarizeWithOpenAI(
  topic: string,
  results: SearchResult[]
): Promise<StructuredResearch> {
  const sourceMaterial = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.url}`)
    .join("\n\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "You are a research analyst. Synthesize search results into structured findings. Be specific and actionable. Respond in valid JSON only.",
      },
      {
        role: "user",
        content: `Topic: "${topic}"

Search results:
${sourceMaterial}

Produce a JSON object with exactly these keys:
- "executive_summary": 2-3 sentence overview
- "key_findings": array of 4-6 key findings (specific, not vague)
- "best_practices": array of 4-6 best practices
- "tools_and_frameworks": array of relevant tools/frameworks mentioned
- "recommendations": array of 3-5 actionable recommendations

Return ONLY the JSON object, no markdown fences.`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(raw);
  } catch {
    // If JSON parsing fails, try extracting from markdown fences
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return JSON.parse(match[1]);
    throw new Error(`Failed to parse OpenAI response as JSON: ${raw.slice(0, 200)}`);
  }
}

// ── Notion block builders ──────────────────────────────────────────────────

function heading1(text: string) {
  return {
    object: "block" as const,
    type: "heading_1" as const,
    heading_1: { rich_text: richText(text) },
  };
}

function heading2(text: string) {
  return {
    object: "block" as const,
    type: "heading_2" as const,
    heading_2: { rich_text: richText(text) },
  };
}

function paragraph(text: string) {
  return {
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: { rich_text: richText(text) },
  };
}

function bullet(text: string) {
  return {
    object: "block" as const,
    type: "bulleted_list_item" as const,
    bulleted_list_item: { rich_text: richText(text) },
  };
}

function numberedItem(text: string) {
  return {
    object: "block" as const,
    type: "numbered_list_item" as const,
    numbered_list_item: { rich_text: richText(text) },
  };
}

function divider() {
  return {
    object: "block" as const,
    type: "divider" as const,
    divider: {},
  };
}

function callout(text: string, emoji = "📌") {
  return {
    object: "block" as const,
    type: "callout" as const,
    callout: {
      rich_text: richText(text),
      icon: { type: "emoji" as const, emoji },
    },
  };
}

function bookmark(url: string) {
  return {
    object: "block" as const,
    type: "bookmark" as const,
    bookmark: { url },
  };
}

// ── Main flow ──────────────────────────────────────────────────────────────

async function main() {
  console.log("🔍 Querying Notion for pending tasks...");

  // 1. Query for pending tasks
  const queryResult = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: { property: "Status", select: { equals: "Pending" } },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 1,
  });

  if (queryResult.results.length === 0) {
    console.log("✅ No pending tasks found.");
    return;
  }

  const task = queryResult.results[0] as any;
  const taskId = task.id;
  const taskUrl = task.url;
  const taskTitle: string = task.properties.Task?.title
    ?.map((t: any) => t.plain_text)
    .join("") ?? "Untitled";

  console.log(`📋 Found task: "${taskTitle}"`);
  console.log(`   ID: ${taskId}`);
  console.log(`   URL: ${taskUrl}`);

  // 2. Set status → Running
  console.log("⏳ Setting status to Running...");
  await notion.pages.update({
    page_id: taskId,
    properties: {
      Status: { select: { name: "Running" } },
    },
  });

  try {
    // 3. Extract topic
    const topic = taskTitle.replace(/^Research:\s*/i, "").trim();
    console.log(`🔬 Research topic: "${topic}"`);

    // 4. Search with Brave
    console.log("🌐 Searching the web...");
    const searchResults = await braveSearch(topic, 10);
    console.log(`   Found ${searchResults.length} results`);

    // 5. Summarize with OpenAI
    console.log("🤖 Summarizing with OpenAI...");
    const research = await summarizeWithOpenAI(topic, searchResults);
    console.log("   Summary generated");

    // 6. Build Notion page content
    const blocks: any[] = [
      callout(
        `Research conducted on ${new Date().toISOString().split("T")[0]} • ${searchResults.length} sources analysed • AI-summarised`,
        "🔬"
      ),
      divider(),

      heading1("Executive Summary"),
      paragraph(research.executive_summary),
      divider(),

      heading1("Key Findings"),
      ...research.key_findings.map((f) => bullet(f)),
      divider(),

      heading1("Best Practices"),
      ...research.best_practices.map((p) => numberedItem(p)),
      divider(),

      heading1("Tools & Frameworks"),
      ...research.tools_and_frameworks.map((t) => bullet(t)),
      divider(),

      heading1("Recommendations"),
      ...research.recommendations.map((r) => numberedItem(r)),
      divider(),

      heading2("Sources"),
      ...searchResults.map((r) =>
        bullet(`${r.title} — ${r.url}`)
      ),
    ];

    // 7. Create Notion results page (child of database, not the task page)
    console.log("📝 Creating results page in Notion...");
    const page = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      icon: { type: "emoji", emoji: "📊" },
      properties: {
        Task: { title: richText(`📊 Results: ${topic}`) },
        Status: { select: { name: "Done" } },
        Agent: { select: { name: "research" } },
      },
      children: blocks,
    });

    const resultsUrl = (page as any).url;
    const resultsId = (page as any).id;
    console.log(`✅ Results page created: ${resultsUrl}`);

    // 8. Update original task: Result field + status → Done
    const summaryText = `${research.executive_summary}\n\nResults page: ${resultsUrl}`;
    await notion.pages.update({
      page_id: taskId,
      properties: {
        Status: { select: { name: "Done" } },
        Result: {
          rich_text: richText(summaryText.substring(0, 2000)),
        },
      },
    });

    console.log("✅ Task marked as Done");
    console.log("");
    console.log("═══════════════════════════════════════════════");
    console.log("  RESEARCH COMPLETE");
    console.log(`  Topic: ${topic}`);
    console.log(`  Results: ${resultsUrl}`);
    console.log(`  Task: ${taskUrl}`);
    console.log(`  Sources: ${searchResults.length}`);
    console.log("═══════════════════════════════════════════════");
  } catch (err: any) {
    // If anything fails, mark task as Failed
    console.error("❌ Error:", err.message);
    await notion.pages.update({
      page_id: taskId,
      properties: {
        Status: { select: { name: "Failed" } },
        Result: {
          rich_text: richText(`Error: ${err.message}`.substring(0, 2000)),
        },
      },
    });
    throw err;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
