import fetch, { Response } from "node-fetch";
import { Logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AirtableAttachment {
  id: string;
  url: string;
  filename: string;
  size: number;
  type: string;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

export type ProcessingStatus = "Pending" | "Processing" | "Uploaded" | "Failed";

// ── Config ──────────────────────────────────────────────────────────────────

interface AirtableConfig {
  apiKey: string;
  baseId: string;
  tableName: string;
  attachmentsField: string;
  statusField: string;
  errorField: string;
  boxLinksField: string;
  boxIdsField: string;
}

export function getAirtableConfig(): AirtableConfig {
  return {
    apiKey: requireEnv("AIRTABLE_API_KEY"),
    baseId: requireEnv("AIRTABLE_BASE_ID"),
    tableName: requireEnv("AIRTABLE_TABLE_NAME"),
    attachmentsField: process.env.AIRTABLE_ATTACHMENTS_FIELD || "Files",
    statusField: process.env.AIRTABLE_STATUS_FIELD || "Status",
    errorField: process.env.AIRTABLE_ERROR_FIELD || "ErrorMessage",
    boxLinksField: process.env.AIRTABLE_BOX_LINKS_FIELD || "BoxLinks",
    boxIdsField: process.env.AIRTABLE_BOX_IDS_FIELD || "BoxFileIds",
  };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function baseUrl(cfg: AirtableConfig, tableName?: string): string {
  const table = tableName || cfg.tableName;
  return `https://api.airtable.com/v0/${cfg.baseId}/${encodeURIComponent(table)}`;
}

function headers(cfg: AirtableConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
  };
}

async function airtableFetch(
  url: string,
  cfg: AirtableConfig,
  opts: { method?: string; body?: unknown } = {},
  log: Logger
): Promise<unknown> {
  const method = opts.method || "GET";
  const fetchOpts: import("node-fetch").RequestInit = {
    method,
    headers: headers(cfg),
  };
  if (opts.body) fetchOpts.body = JSON.stringify(opts.body);

  let resp: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      resp = await fetch(url, fetchOpts);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Airtable fetch attempt ${attempt + 1} failed: ${msg}`);
      if (attempt < 2) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }

    if (resp.status === 429) {
      // Airtable rate-limit — back off and retry
      const retryAfter = parseInt(resp.headers.get("retry-after") || "5", 10);
      log.warn(`Airtable 429, retrying after ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (resp.status >= 500 && attempt < 2) {
      log.warn(`Airtable ${resp.status}, retrying (attempt ${attempt + 1})`);
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    break;
  }

  if (!resp) throw new Error("Airtable request failed after retries");

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Airtable ${method} ${url} → ${resp.status}: ${text}`);
  }

  return resp.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch a single record by ID.
 */
export async function getRecord(
  recordId: string,
  log: Logger,
  tableName?: string
): Promise<AirtableRecord> {
  const cfg = getAirtableConfig();
  const url = `${baseUrl(cfg, tableName)}/${recordId}`;
  const data = (await airtableFetch(url, cfg, {}, log)) as AirtableRecord;
  return data;
}

/**
 * Extract attachment objects from a record's attachment field.
 */
export function getAttachments(
  record: AirtableRecord,
  attachmentsField?: string
): AirtableAttachment[] {
  const cfg = getAirtableConfig();
  const field = attachmentsField || cfg.attachmentsField;
  const raw = record.fields[field];
  if (!Array.isArray(raw)) return [];
  return raw.map((a: Record<string, unknown>) => ({
    id: String(a.id || ""),
    url: String(a.url || ""),
    filename: String(a.filename || "unknown"),
    size: Number(a.size) || 0,
    type: String(a.type || "application/octet-stream"),
  }));
}

/**
 * Read the current status from a record.
 */
export function getStatus(record: AirtableRecord): ProcessingStatus | null {
  const cfg = getAirtableConfig();
  const val = record.fields[cfg.statusField];
  if (typeof val === "string") return val as ProcessingStatus;
  return null;
}

/**
 * Read existing Box file IDs stored on the record.
 */
export function getExistingBoxIds(record: AirtableRecord): string[] {
  const cfg = getAirtableConfig();
  const val = record.fields[cfg.boxIdsField];
  if (typeof val === "string" && val.trim()) {
    return val
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Read existing Box links stored on the record.
 */
export function getExistingBoxLinks(record: AirtableRecord): string[] {
  const cfg = getAirtableConfig();
  const val = record.fields[cfg.boxLinksField];
  if (typeof val === "string" && val.trim()) {
    return val
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Update arbitrary fields on a record.
 */
export async function updateRecord(
  recordId: string,
  fields: Record<string, unknown>,
  log: Logger,
  tableName?: string
): Promise<void> {
  const cfg = getAirtableConfig();
  const url = `${baseUrl(cfg, tableName)}/${recordId}`;
  await airtableFetch(
    url,
    cfg,
    { method: "PATCH", body: { fields } },
    log
  );
}

/**
 * Set the processing status on a record.
 */
export async function setStatus(
  recordId: string,
  status: ProcessingStatus,
  log: Logger,
  errorMessage?: string
): Promise<void> {
  const cfg = getAirtableConfig();
  const fields: Record<string, unknown> = {
    [cfg.statusField]: status,
  };
  if (errorMessage !== undefined) {
    fields[cfg.errorField] = errorMessage;
  }
  // Clear error when not failing
  if (status !== "Failed" && errorMessage === undefined) {
    fields[cfg.errorField] = "";
  }
  await updateRecord(recordId, fields, log);
}

/**
 * Write Box results (file IDs and shared links) back to Airtable.
 */
export async function writeBoxResults(
  recordId: string,
  boxIds: string[],
  boxLinks: string[],
  log: Logger
): Promise<void> {
  const cfg = getAirtableConfig();
  const fields: Record<string, unknown> = {
    [cfg.boxIdsField]: boxIds.join("\n"),
    [cfg.boxLinksField]: boxLinks.join("\n"),
    [cfg.statusField]: "Uploaded" as ProcessingStatus,
    [cfg.errorField]: "",
  };
  await updateRecord(recordId, fields, log);
}

/**
 * Download an attachment from Airtable's CDN and return the response
 * as a readable stream. Airtable attachment URLs are time-limited
 * signed URLs; they must be consumed promptly.
 *
 * VERCEL LIMIT: Vercel serverless functions have a ~4.5 MB response body
 * and ~50 MB payload limit (varies by plan). For very large files the
 * download may be cut short. This implementation streams the response
 * body so memory stays low, but the total transfer is still bounded by
 * Vercel's execution-time and payload limits.
 */
export async function downloadAttachmentStream(
  attachmentUrl: string,
  log: Logger
): Promise<{ stream: NodeJS.ReadableStream; contentLength: number | null }> {
  let resp: Response | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      resp = await fetch(attachmentUrl);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Download attempt ${attempt + 1} failed: ${msg}`);
      if (attempt < 2) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }

    if (resp.status >= 500 && attempt < 2) {
      log.warn(`Download ${resp.status}, retrying (attempt ${attempt + 1})`);
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }
    break;
  }

  if (!resp || !resp.ok) {
    throw new Error(
      `Failed to download attachment: ${resp?.status ?? "no response"}`
    );
  }

  const cl = resp.headers.get("content-length");
  return {
    stream: resp.body as unknown as NodeJS.ReadableStream,
    contentLength: cl ? parseInt(cl, 10) : null,
  };
}
