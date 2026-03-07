/**
 * Task Queue — Poll a Notion database for pending tasks and process them.
 *
 * Expected database schema:
 *   - Task (title): Task name
 *   - Status (select): Pending → Running → Done / Failed
 *   - Agent (select): research | github-tracker | content-pipeline
 *   - Result (rich_text): Result or error message
 *   - Priority (select): Task priority
 *   - Approved (checkbox): Human approval flag
 */

import { getNotionClient, richTextToPlain, plainToRichText, getPageTitle } from "../utils/notion-client.js";
import { logger } from "../utils/logger.js";

export interface Task {
  id: string;
  name: string;
  type: string;
  input: any;
  url: string;
}

/**
 * Poll for pending tasks in the configured database.
 */
export async function pollPendingTasks(databaseId: string): Promise<Task[]> {
  const notion = getNotionClient();

  const response = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: "Status",
      select: { equals: "Pending" },
    },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 10,
  });

  logger.info("Polled for pending tasks", { count: response.results.length });

  return response.results.map((page: any) => {
    const props = page.properties;
    return {
      id: page.id,
      name: getPageTitle(props) ?? "Untitled",
      type: props.Agent?.select?.name ?? "unknown",
      input: {},
      url: page.url,
    };
  });
}

/**
 * Claim a task by setting its status to "Running".
 */
export async function claimTask(taskId: string): Promise<void> {
  const notion = getNotionClient();

  await notion.pages.update({
    page_id: taskId,
    properties: {
      Status: { select: { name: "Running" } },
    },
  });

  logger.info("Claimed task", { taskId });
}

/**
 * Complete a task by writing the result and setting status to "Done".
 */
export async function completeTask(taskId: string, result: any): Promise<void> {
  const notion = getNotionClient();

  const outputText = JSON.stringify(result, null, 2);

  await notion.pages.update({
    page_id: taskId,
    properties: {
      Status: { select: { name: "Done" } },
      Result: { rich_text: plainToRichText(outputText.substring(0, 2000)) },
    },
  });

  logger.info("Completed task", { taskId });
}

/**
 * Fail a task by writing the error and setting status to "Failed".
 */
export async function failTask(taskId: string, error: string): Promise<void> {
  const notion = getNotionClient();

  await notion.pages.update({
    page_id: taskId,
    properties: {
      Status: { select: { name: "Failed" } },
      Result: { rich_text: plainToRichText(`Error: ${error}`.substring(0, 2000)) },
    },
  });

  logger.warn("Failed task", { taskId, error });
}

/**
 * Process a single task through the queue lifecycle.
 */
export async function processTask(
  task: Task,
  handler: (task: Task) => Promise<any>
): Promise<void> {
  try {
    await claimTask(task.id);
    const result = await handler(task);
    await completeTask(task.id, result);
  } catch (err: any) {
    await failTask(task.id, err.message);
  }
}

/**
 * Start the queue polling loop.
 */
export async function startQueue(
  databaseId: string,
  handler: (task: Task) => Promise<any>,
  intervalMs = 10000
): Promise<() => void> {
  let running = true;

  const poll = async () => {
    while (running) {
      try {
        const tasks = await pollPendingTasks(databaseId);
        for (const task of tasks) {
          await processTask(task, handler);
        }
      } catch (err: any) {
        logger.error("Queue poll error", { error: err.message });
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  poll();

  return () => {
    running = false;
  };
}
