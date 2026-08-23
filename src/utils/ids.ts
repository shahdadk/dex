import { randomBytes, randomUUID } from "node:crypto";

export function eventId(): string {
  return `evt_${randomUUID()}`;
}

export function workerId(): string {
  return `worker_${randomUUID()}`;
}

export function projectId(): string {
  return `project_${randomBytes(5).toString("hex")}`;
}

export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return slug || "task";
}

export function taskId(title: string): string {
  return `${slugify(title)}-${randomBytes(2).toString("hex")}`;
}
