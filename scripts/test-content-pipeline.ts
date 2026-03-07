/**
 * Test script for the Content Pipeline agent.
 *
 * 1. Queries Task Queue for pending tasks with Agent = "Content Pipeline"
 * 2. Picks up a task and sets status → Running
 * 3. Uses OpenAI (gpt-4o-mini) to generate an article draft
 * 4. Creates a new Notion page with rich content blocks
 * 5. Updates the task with result summary and "Awaiting Review" status
 */

import { Client } from "@notionhq/client";
import OpenAI from "openai";

// --- Config ---
const TASK_QUEUE_DB = "31c4214c-ba08-8116-9917-fd1428d45588";
const PARENT_PAGE_ID = "31c4214c-ba08-80c4-a81f-cf1da59e19c8";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Helpers ---
function richText(text: string) {
  // Notion rich_text items have a 2000 char limit per element
  const chunks: { type: "text"; text: { content: string } }[] = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ type: "text", text: { content: text.slice(i, i + 2000) } });
  }
  return chunks.length ? chunks : [{ type: "text" as const, text: { content: "" } }];
}

function paragraph(text: string) {
  return { object: "block" as const, type: "paragraph" as const, paragraph: { rich_text: richText(text) } };
}

function heading2(text: string) {
  return { object: "block" as const, type: "heading_2" as const, heading_2: { rich_text: richText(text) } };
}

function heading3(text: string) {
  return { object: "block" as const, type: "heading_3" as const, heading_3: { rich_text: richText(text) } };
}

function bullet(text: string) {
  return { object: "block" as const, type: "bulleted_list_item" as const, bulleted_list_item: { rich_text: richText(text) } };
}

function codeBlock(code: string, language = "typescript") {
  return { object: "block" as const, type: "code" as const, code: { rich_text: richText(code), language } };
}

function callout(text: string, emoji = "⚠️") {
  return {
    object: "block" as const,
    type: "callout" as const,
    callout: { rich_text: richText(text), icon: { type: "emoji" as const, emoji } },
  };
}

function divider() {
  return { object: "block" as const, type: "divider" as const, divider: {} };
}

// --- Parse markdown-ish LLM output into Notion blocks ---
function markdownToBlocks(markdown: string): any[] {
  const lines = markdown.split("\n");
  const blocks: any[] = [];

  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = "typescript";

  for (const line of lines) {
    // Code fence start/end
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        blocks.push(codeBlock(codeLines.join("\n"), codeLang));
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLang = line.trim().replace("```", "").trim() || "typescript";
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("## ")) {
      blocks.push(heading2(trimmed.slice(3)));
    } else if (trimmed.startsWith("### ")) {
      blocks.push(heading3(trimmed.slice(4)));
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      blocks.push(bullet(trimmed.slice(2)));
    } else {
      blocks.push(paragraph(trimmed));
    }
  }

  // Close any unclosed code block
  if (inCodeBlock && codeLines.length) {
    blocks.push(codeBlock(codeLines.join("\n"), codeLang));
  }

  return blocks;
}

// --- Main ---
async function main() {
  console.log("🔍 Querying Task Queue for pending Content Pipeline tasks...");

  // Step 1: Query for pending tasks
  const queryResult = await notion.databases.query({
    database_id: TASK_QUEUE_DB,
    filter: {
      and: [
        { property: "Status", select: { equals: "Pending" } },
        { property: "Agent", select: { equals: "Content Pipeline" } },
      ],
    },
  });

  if (queryResult.results.length === 0) {
    console.log("❌ No pending Content Pipeline tasks found.");
    return;
  }

  const task = queryResult.results[0] as any;
  const taskId = task.id;
  const taskTitle = task.properties.Task.title.map((t: any) => t.plain_text).join("");
  console.log(`📋 Found task: "${taskTitle}" (${taskId})`);

  // Step 2: Set status → Running
  console.log("🏃 Setting status to Running...");
  await notion.pages.update({
    page_id: taskId,
    properties: { Status: { select: { name: "Running" } } },
  });

  try {
    // Step 3: Generate article with OpenAI
    console.log("🤖 Generating article draft with OpenAI (gpt-4o-mini)...");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a technical content writer for Dev.to. Write engaging, practical articles for developers.
Use markdown formatting:
- ## for main sections (3-5 sections)
- ### for subsections
- \`\`\`typescript or \`\`\`bash for code blocks
- Bullet lists with - for key points
- Keep paragraphs concise (2-4 sentences)

Target: 800-1200 words. Include an intro, practical sections with code examples, and a conclusion with a call to action.
Do NOT include a title — the title is provided separately.`,
        },
        {
          role: "user",
          content: `Write a full article draft for: "${taskTitle}"`,
        },
      ],
      temperature: 0.7,
      max_tokens: 3000,
    });

    const articleMarkdown = completion.choices[0].message.content ?? "";
    console.log(`✍️  Generated ${articleMarkdown.length} chars of content`);

    // Step 4: Create Notion page with rich blocks
    console.log("📝 Creating draft page in Notion...");
    const articleBlocks = markdownToBlocks(articleMarkdown);

    // Notion API limits: 100 children per request
    const firstBatch = [
      callout("⚠️ DRAFT — Awaiting human review. Check the Approved box in the Task Queue when satisfied.", "⚠️"),
      divider(),
      ...articleBlocks.slice(0, 98),
    ];

    const draftPage = await notion.pages.create({
      parent: { page_id: PARENT_PAGE_ID },
      icon: { type: "emoji", emoji: "📝" },
      properties: {
        title: { title: richText(`[DRAFT] ${taskTitle.replace("Write article: ", "")}`) },
      },
      children: firstBatch as any,
    });

    const draftUrl = (draftPage as any).url;
    const draftId = (draftPage as any).id;
    console.log(`✅ Draft page created: ${draftUrl}`);

    // Append remaining blocks if more than 98
    if (articleBlocks.length > 98) {
      const remaining = articleBlocks.slice(98);
      for (let i = 0; i < remaining.length; i += 100) {
        await notion.blocks.children.append({
          block_id: draftId,
          children: remaining.slice(i, i + 100) as any,
        });
      }
    }

    // Step 5: Update task with result and status
    const resultSummary = `Draft created: "${taskTitle.replace("Write article: ", "")}" (~${articleMarkdown.split(/\s+/).length} words)\n\nDraft page: ${draftUrl}\n\nReview the draft in Notion and check "Approved" when ready.`;

    await notion.pages.update({
      page_id: taskId,
      properties: {
        Status: { select: { name: "Awaiting Review" } },
        Result: { rich_text: richText(resultSummary) },
      },
    });

    console.log("✅ Task updated to 'Awaiting Review'");
    console.log(`\n🎉 Content Pipeline complete!`);
    console.log(`   Draft: ${draftUrl}`);
    console.log(`   Task:  https://notion.so/${taskId.replace(/-/g, "")}`);
    console.log(`\n📌 Human-in-the-loop: Review the draft in Notion, then check "Approved" in the Task Queue.`);
  } catch (error) {
    // On failure, set status back to Pending
    console.error("❌ Error:", error);
    await notion.pages.update({
      page_id: taskId,
      properties: {
        Status: { select: { name: "Pending" } },
        Result: { rich_text: richText(`Error: ${(error as Error).message}`) },
      },
    });
    process.exit(1);
  }
}

main().catch(console.error);
