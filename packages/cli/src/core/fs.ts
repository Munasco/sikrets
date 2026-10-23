import { chmod, mkdir } from "node:fs/promises";

// Bun-native file helpers. Bun.write creates missing parent folders and Bun.file reads lazily.
// Bun has no permission API, so private files fall back to node:fs chmod/mkdir for 0600/0700.

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  const f = Bun.file(file);
  return (await f.exists()) ? ((await f.json()) as T) : fallback;
}

export const readText = async (file: string) => {
  const f = Bun.file(file);
  return (await f.exists()) ? f.text() : undefined;
};

export const writeJson = (file: string, value: unknown) => Bun.write(file, JSON.stringify(value, null, 2) + "\n");

/** Writes a file only you can read, inside a folder only you can open. */
export async function writePrivate(file: string, text: string) {
  await privateDir(file.slice(0, file.lastIndexOf("/")));
  await Bun.write(file, text);
  await chmod(file, 0o600);
}

export async function privateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export const remove = async (file: string) => {
  const f = Bun.file(file);
  if (await f.exists()) await f.delete();
};
