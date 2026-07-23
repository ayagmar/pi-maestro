import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function enforceMode(path: string, mode: number): void {
  if (process.platform !== "win32") chmodSync(path, mode);
}

/** Create or tighten a Maestro runtime directory without changing Windows ACLs. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  enforceMode(path, PRIVATE_DIRECTORY_MODE);
}

/** Tighten an existing Maestro runtime file on POSIX. */
export function ensurePrivateFile(path: string): void {
  enforceMode(path, PRIVATE_FILE_MODE);
}

/** Write a Maestro runtime file with private creation and replacement modes. */
export function writePrivateFile(
  path: string,
  data: string | NodeJS.ArrayBufferView,
  options: { flag?: string } = {}
): void {
  writeFileSync(path, data, {
    mode: PRIVATE_FILE_MODE,
    ...(options.flag ? { flag: options.flag } : {}),
  });
  ensurePrivateFile(path);
}

/** Append to a Maestro runtime file, tightening a pre-existing permissive file. */
export function appendPrivateFile(path: string, data: string): void {
  appendFileSync(path, data, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  ensurePrivateFile(path);
}
