// Runs a script of this repository with Node and the .env settings, and captures its output
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));

export type ScriptResult = { ok: boolean; stdout: string; stderr: string };

const runFile = promisify(execFile);

// Runs a script path relative to the repository root, such as cli/stipend.ts
export async function runScript(script: string, args: string[]): Promise<ScriptResult> {
  try {
    const { stdout, stderr } = await runFile("node", ["--env-file=.env", script, ...args], { cwd: REPO_DIR });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout, stderr };
  }
}
