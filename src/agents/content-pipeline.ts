/**
 * Content Pipeline Agent — Picks up article tasks from the Task Queue,
 * generates draft content using OpenAI, and writes rich Notion pages
 * for human review.
 *
 * Workflow:
 * 1. Query Task Queue for pending "Content Pipeline" tasks
 * 2. Generate article draft via OpenAI (gpt-4o-mini)
 * 3. Create a rich Notion draft page with headings, code blocks, callouts
 * 4. Update the task with result + "Awaiting Review" status
 * 5. Human reviews in Notion, checks "Approved" checkbox
 */

import { getNotionClient, plainToRichText } from "../utils/notion-client.js";
import { logger } from "../utils/logger.js";
import type { Task } from "../queue/task-queue.js";
import OpenAI from "openai";

export interface ContentPipelineConfig {
  taskQueueDbId: string;
  parentPageId: string;
  model?: string;         // OpenAI model, default gpt-4o-mini
  temperature?: number;
  maxTokens?: number;
}

// --- Block Helpers ---

function richText(text: string) {
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

/**
 * Parse markdown output from OpenAI into Notion block objects.
 */
function markdownToBlocks(markdown: string): any[] {
  const lines = markdown.split("\n");
  const blocks: any[] = [];

  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = "typescript";

  for (const line of lines) {
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

  if (inCodeBlock && codeLines.length) {
    blocks.push(codeBlock(codeLines.join("\n"), codeLang));
  }

  return blocks;
}

/**
 * Generate an article draft using OpenAI.
 */
async function generateArticle(title: string, config: ContentPipelineConfig): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const completion = await openai.chat.completions.create({
    model: config.model ?? "gpt-4o-mini",
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
        content: `Write a full article draft for: "${title}"`,
      },
    ],
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 3000,
  });

  return completion.choices[0].message.content ?? "";
}

/**
 * Run the content pipeline: query tasks, generate content, create pages.
 */
export async function runContentPipeline(config: ContentPipelineConfig) {
  const notion = getNotionClient();

  logger.info("Querying Task Queue for pending Content Pipeline tasks...");
  const queryResult = await notion.databases.query({
    database_id: config.taskQueueDbId,
    filter: {
      and: [
        { property: "Status", select: { equals: "Pending" } },
        { property: "Agent", select: { equals: "Content Pipeline" } },
      ],
    },
  });

  if (queryResult.results.length === 0) {
    logger.info("No pending Content Pipeline tasks found.");
    return { processed: 0 };
  }

  const results: Array<{ taskId: string; draftUrl: string; title: string }> = [];

  for (const page of queryResult.results) {
    const task = page as any;
    const taskId = task.id;
    const taskTitle = task.properties.Task.title
      .map((t: any) => t.plain_text)
      .join("");

    logger.info(`Processing task: "${taskTitle}"`);

    // Set status → Running
    await notion.pages.update({
      page_id: taskId,
      properties: { Status: { select: { name: "Running" } } },
    });

    try {
      // Generate article
      const articleMarkdown = await generateArticle(taskTitle, config);
      const articleBlocks = markdownToBlocks(articleMarkdown);
      const wordCount = articleMarkdown.split(/\s+/).length;

      logger.info(`Generated ${wordCount} words of content`);

      // Create draft page (max 100 children per request)
      const firstBatch = [
        callout("⚠️ DRAFT — Awaiting human review. Check the Approved box in the Task Queue when satisfied.", "⚠️"),
        divider(),
        ...articleBlocks.slice(0, 98),
      ];

      const displayTitle = taskTitle.replace(/^Write article:\s*/i, "");
      const draftPage = await notion.pages.create({
        parent: { page_id: config.parentPageId },
        icon: { type: "emoji", emoji: "📝" },
        properties: {
          title: { title: plainToRichText(`[DRAFT] ${displayTitle}`) },
        },
        children: firstBatch as any,
      });

      const draftUrl = (draftPage as any).url;
      const draftId = (draftPage as any).id;

      // Append remaining blocks
      if (articleBlocks.length > 98) {
        const remaining = articleBlocks.slice(98);
        for (let i = 0; i < remaining.length; i += 100) {
          await notion.blocks.children.append({
            block_id: draftId,
            children: remaining.slice(i, i + 100) as any,
          });
        }
      }

      // Update task
      const resultSummary = `Draft created: "${displayTitle}" (~${wordCount} words)\n\nDraft page: ${draftUrl}\n\nReview the draft in Notion and check "Approved" when ready.`;

      await notion.pages.update({
        page_id: taskId,
        properties: {
          Status: { select: { name: "Awaiting Review" } },
          Result: { rich_text: richText(resultSummary) as any },
        },
      });

      results.push({ taskId, draftUrl, title: displayTitle });
      logger.info(`Draft created: ${draftUrl}`);
    } catch (error) {
      logger.error(`Failed to process task ${taskId}`, error);
      await notion.pages.update({
        page_id: taskId,
        properties: {
          Status: { select: { name: "Pending" } },
          Result: { rich_text: richText(`Error: ${(error as Error).message}`) as any },
        },
      });
    }
  }

  return { processed: results.length, results };
}

/**
 * Task queue handler for content pipeline tasks (legacy interface).
 */
export async function handleContentPipelineTask(task: Task) {
  const input = task.input as { taskQueueDbId: string; parentPageId: string };
  return runContentPipeline({
    taskQueueDbId: input.taskQueueDbId,
    parentPageId: input.parentPageId,
  });
}
