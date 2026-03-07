/**
 * Task Queue — Poll a Notion database for pending tasks and process them.
 *
 * Expected database schema:
 *   - Name (title): Task name
 *   - Status (status): Pending → Running → Done / Failed
 *   - Type (select): research | github-tracker | content-pipeline
 *   - Input (rich_text): JSON input for the task
 *   - Output (rich_text): JSON result from the task
 *   - Error (rich_text): Error message if failed
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
      status: { equals: "Pending" },
    },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 10,
  });

  logger.info("Polled for pending tasks", { count: response.results.length });

  return response.results.map((page: any) => {
    const props = page.properties;
    let input = {};

    try {
      const inputText = props.Input?.rich_text
        ? richTextToPlain(props.Input.rich_text)
        : "{}";
      input = JSON.parse(inputText);
    } catch {
      logger.warn("Failed to parse task input", { pageId: page.id });
    }

    return {
      id: page.id,
      name: getPageTitle(props) ?? "Untitled",
      type: props.Type?.select?.name ?? "unknown",
      input,
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
      Status: { status: { name: "Running" } },
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
      Status: { status: { name: "Done" } },
      Output: { rich_text: plainToRichText(outputText.substring(0, 2000)) },
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
      Status: { status: { name: "Failed" } },
      Error: { rich_text: plainToRichText(error.substring(0, 2000)) },
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
