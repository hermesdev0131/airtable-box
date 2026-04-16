import fetch, { Response } from "node-fetch";
import { Logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AirtableAttachment {
  id: string;
  url: string;
  filename: string;
  size: number;
  type: string;
  /** The Airtable field this attachment came from */
  fieldName: string;
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
  /** Comma-separated list of attachment field names */
  attachmentFields: string[];
  statusField: string;
  errorField: string;
  boxFilePathField: string;
  fundField: string;
  companyCodeField: string;
  companyNameJpField: string;
  submissionPeriodField: string;
  targetYearMonthField: string;
}

const DEFAULT_ATTACHMENT_FIELDS = [
  "株主名簿（最新版）",
  "PL",
  "BS",
  "商業登記簿",
  "新株予約権原簿",
];

export function getAirtableConfig(): AirtableConfig {
  const attachmentFieldsEnv = process.env.AIRTABLE_ATTACHMENT_FIELDS;
  const attachmentFields = attachmentFieldsEnv
    ? attachmentFieldsEnv.split(",").map((s) => s.trim())
    : DEFAULT_ATTACHMENT_FIELDS;

  return {
    apiKey: requireEnv("AIRTABLE_API_KEY"),
    baseId: requireEnv("AIRTABLE_BASE_ID"),
    tableName: process.env.AIRTABLE_TABLE_NAME || "ドキュメント収集管理",
    attachmentFields,
    statusField: process.env.AIRTABLE_STATUS_FIELD || "収集状況管理",
    errorField: process.env.AIRTABLE_ERROR_FIELD || "ErrorMessage",
    boxFilePathField: process.env.AIRTABLE_BOX_FILE_PATH_FIELD || "Boxファイルパス",
    fundField: process.env.AIRTABLE_FUND_FIELD || "Fund / ファンド (from 会社名)",
    companyCodeField:
      process.env.AIRTABLE_COMPANY_CODE_FIELD ||
      "Company Code / 会社コード (from 会社名)",
    companyNameJpField:
      process.env.AIRTABLE_COMPANY_NAME_JP_FIELD ||
      "Company Name (JP) / 会社名（日本語） (from 会社名)",
    submissionPeriodField:
      process.env.AIRTABLE_SUBMISSION_PERIOD_FIELD || "提出期間",
    targetYearMonthField:
      process.env.AIRTABLE_TARGET_YEAR_MONTH_FIELD || "対象年月",
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
 * Extract attachment objects from a single attachment field.
 */
function parseAttachmentField(
  record: AirtableRecord,
  fieldName: string
): AirtableAttachment[] {
  const raw = record.fields[fieldName];
  if (!Array.isArray(raw)) return [];
  return raw.map((a: Record<string, unknown>) => ({
    id: String(a.id || ""),
    url: String(a.url || ""),
    filename: String(a.filename || "unknown"),
    size: Number(a.size) || 0,
    type: String(a.type || "application/octet-stream"),
    fieldName,
  }));
}

/**
 * Extract attachments from ALL configured attachment fields.
 */
export function getAllAttachments(record: AirtableRecord): AirtableAttachment[] {
  const cfg = getAirtableConfig();
  const all: AirtableAttachment[] = [];
  for (const field of cfg.attachmentFields) {
    all.push(...parseAttachmentField(record, field));
  }
  return all;
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
 * Read the fund name (e.g. "4号") from a record.
 * Handles both direct string values and lookup arrays (e.g. ["4号"]).
 */
export function getFundName(record: AirtableRecord): string | null {
  const cfg = getAirtableConfig();
  const val = record.fields[cfg.fundField];
  // Lookup fields return arrays
  if (Array.isArray(val) && val.length > 0) {
    const first = val[0];
    if (typeof first === "string" && first.trim()) return first.trim();
  }
  if (typeof val === "string" && val.trim()) return val.trim();
  return null;
}

/**
 * Read the company code from a record.
 * Handles both direct string values and lookup arrays (e.g. ["ABC123"]).
 */
export function getCompanyCode(record: AirtableRecord): string | null {
  const cfg = getAirtableConfig();
  const val = record.fields[cfg.companyCodeField];
  // Lookup fields return arrays
  if (Array.isArray(val) && val.length > 0) {
    const first = val[0];
    if (typeof first === "string" && first.trim()) return first.trim();
  }
  if (typeof val === "string" && val.trim()) return val.trim();
  return null;
}

/**
 * Read the company name (JP) from a record.
 * Handles both direct string values and lookup arrays.
 */
export function getCompanyNameJp(record: AirtableRecord): string | null {
  const cfg = getAirtableConfig();
  const val = record.fields[cfg.companyNameJpField];
  if (Array.isArray(val) && val.length > 0) {
    const first = val[0];
    if (typeof first === "string" && first.trim()) return first.trim();
  }
  if (typeof val === "string" && val.trim()) return val.trim();
  return null;
}

/**
 * Read the submission period (提出期間) from a record.
 * This is a Formula field, returns a string like "Q1 2025".
 */
export function getSubmissionPeriod(record: AirtableRecord): string | null {
  const cfg = getAirtableConfig();
  const val = record.fields[cfg.submissionPeriodField];
  if (typeof val === "string" && val.trim()) return val.trim();
  return null;
}

/**
 * Read the target year/month (対象年月) from a record.
 * Example values: "2026年3月", "2025年12月"
 */
export function getTargetYearMonth(record: AirtableRecord): string | null {
  const cfg = getAirtableConfig();
  const val = record.fields[cfg.targetYearMonthField];
  if (Array.isArray(val) && val.length > 0) {
    const first = val[0];
    if (typeof first === "string" && first.trim()) return first.trim();
  }
  if (typeof val === "string" && val.trim()) return val.trim();
  return null;
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
 * Write the Box folder URL and mark as Uploaded.
 */
export async function writeBoxResult(
  recordId: string,
  boxFolderUrl: string,
  log: Logger
): Promise<void> {
  const cfg = getAirtableConfig();
  const fields: Record<string, unknown> = {
    [cfg.boxFilePathField]: boxFolderUrl,
    [cfg.statusField]: "Uploaded" as ProcessingStatus,
    [cfg.errorField]: "",
  };
  await updateRecord(recordId, fields, log);
}

/**
 * Download an attachment from Airtable's CDN and return the response
 * as a readable stream. Airtable attachment URLs are time-limited
 * signed URLs; they must be consumed promptly.
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
