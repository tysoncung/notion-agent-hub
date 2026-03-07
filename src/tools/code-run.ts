/**
 * code-run tool — Sandboxed JavaScript code execution.
 * Uses Node.js vm module for isolation.
 */

import { z } from "zod";
import vm from "node:vm";
import { logger } from "../utils/logger.js";

export const codeRunSchema = z.object({
  code: z.string().describe("JavaScript code to execute"),
  timeout_ms: z.number().min(100).max(30000).optional().default(5000).describe("Execution timeout in milliseconds"),
});

export type CodeRunInput = z.infer<typeof codeRunSchema>;

/**
 * Execute JavaScript code in a sandboxed VM context.
 * Returns captured console output and the final expression value.
 */
export async function codeRun(input: CodeRunInput) {
  const logs: string[] = [];
  const errors: string[] = [];

  // Build a sandbox with captured console
  const sandbox = {
    console: {
      log: (...args: any[]) => logs.push(args.map(String).join(" ")),
      error: (...args: any[]) => errors.push(args.map(String).join(" ")),
      warn: (...args: any[]) => logs.push(`[warn] ${args.map(String).join(" ")}`),
      info: (...args: any[]) => logs.push(args.map(String).join(" ")),
    },
    Math,
    Date,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    RegExp,
    Error,
    Promise,
    // Intentionally excluded: require, process, fs, fetch, etc.
  };

  const context = vm.createContext(sandbox);
  const timeoutMs = input.timeout_ms ?? 5000;

  logger.info("Executing code", { length: input.code.length, timeoutMs });

  try {
    const script = new vm.Script(input.code, {
      filename: "user-code.js",
    });

    const result = script.runInContext(context, {
      timeout: timeoutMs,
      displayErrors: true,
    });

    return {
      success: true,
      result: result !== undefined ? String(result) : null,
      stdout: logs,
      stderr: errors,
    };
  } catch (err: any) {
    logger.warn("Code execution failed", { error: err.message });

    return {
      success: false,
      error: err.message,
      stdout: logs,
      stderr: errors,
    };
  }
}
