/**
 * Output utilities for CLI.
 * - stdout: only data (message body, JSON, table)
 * - stderr: progress, status, errors
 * - --json flag: structured JSON to stdout
 */

export function printSuccess(message: string): void {
  process.stderr.write(`✓ ${message}\n`);
}

export function printError(message: string): void {
  process.stderr.write(`✗ ${message}\n`);
}

export function printWarning(message: string): void {
  process.stderr.write(`⚠ ${message}\n`);
}

export function printInfo(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function printData(data: string): void {
  process.stdout.write(`${data}\n`);
}

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}
