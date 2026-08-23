import { execa, type Options } from "execa";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function execFile(
  command: string,
  args: readonly string[],
  options: Options = {},
): Promise<ExecResult> {
  const result = await execa(command, [...args], {
    reject: false,
    ...options,
  });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    exitCode: result.exitCode ?? 1,
  };
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await execFile("/usr/bin/env", ["which", command]);
  return result.exitCode === 0;
}
