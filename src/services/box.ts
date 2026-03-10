import fetch, { Response } from "node-fetch";
import * as crypto from "crypto";
import { Logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────────────────

export interface BoxFile {
  id: string;
  name: string;
  sharedLink: string | null;
}

interface BoxTokenResponse {
  access_token: string;
  expires_in: number;
}

interface BoxUploadEntry {
  id: string;
  name: string;
  shared_link?: { url: string } | null;
}

// ── Config ──────────────────────────────────────────────────────────────────

interface BoxConfig {
  /** When set, skip CCG auth and use this token directly (for local testing) */
  developerToken: string | null;
  clientId: string;
  clientSecret: string;
  enterpriseId: string;
  targetFolderId: string;
  sharedLinkAccess: string | null;
}

function getBoxConfig(): BoxConfig {
  const developerToken = process.env.BOX_DEVELOPER_TOKEN || null;

  return {
    developerToken,
    clientId: developerToken ? (process.env.BOX_CLIENT_ID || "") : requireEnv("BOX_CLIENT_ID"),
    clientSecret: developerToken ? (process.env.BOX_CLIENT_SECRET || "") : requireEnv("BOX_CLIENT_SECRET"),
    enterpriseId: developerToken ? (process.env.BOX_ENTERPRISE_ID || "") : requireEnv("BOX_ENTERPRISE_ID"),
    targetFolderId: requireEnv("BOX_TARGET_FOLDER_ID"),
    sharedLinkAccess: process.env.BOX_SHARED_LINK_ACCESS || null,
  };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

// ── Token cache (per cold-start) ────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Obtain a Box access token.
 *
 * If BOX_DEVELOPER_TOKEN is set, uses it directly (for local testing).
 * Otherwise, uses CCG (Client Credentials Grant) for server-to-server auth.
 * Tokens are cached in-memory for the duration of the serverless
 * cold-start (up to their expiry minus a 60s buffer).
 */
async function getAccessToken(log: Logger): Promise<string> {
  const cfg = getBoxConfig();

  // Developer token mode — use directly, no caching needed
  if (cfg.developerToken) {
    return cfg.developerToken;
  }

  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    box_subject_type: "enterprise",
    box_subject_id: cfg.enterpriseId,
  });

  const resp = await fetch("https://api.box.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Box CCG auth failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as BoxTokenResponse;
  cachedToken = data.access_token;
  // Cache until 60 seconds before actual expiry
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

  log.info("Box CCG token obtained");
  return cachedToken;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wrapper around Box API calls with retry + token refresh on 401.
 */
async function boxApiFetch(
  url: string,
  opts: import("node-fetch").RequestInit,
  log: Logger,
  retries = 3
): Promise<Response> {
  let resp: Response | undefined;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await fetch(url, opts);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Box API fetch attempt ${attempt + 1} failed: ${msg}`);
      if (attempt < retries - 1) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }

    // 401 → refresh token and retry once
    if (resp.status === 401 && attempt === 0) {
      log.warn("Box 401 — clearing token cache and retrying");
      cachedToken = null;
      tokenExpiresAt = 0;
      const newToken = await getAccessToken(log);
      // Replace Authorization header
      const h = opts.headers as Record<string, string>;
      h["Authorization"] = `Bearer ${newToken}`;
      continue;
    }

    // Retry on 5xx
    if (resp.status >= 500 && attempt < retries - 1) {
      log.warn(`Box ${resp.status}, retrying (attempt ${attempt + 1})`);
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    break;
  }

  if (!resp) throw new Error("Box request failed after retries");
  return resp;
}

// ── Folder management ───────────────────────────────────────────────────────

/**
 * Find or create a subfolder (e.g. "2025-01") under the target folder.
 * Returns the Box folder ID.
 */
export async function ensureSubfolder(
  parentFolderId: string,
  folderName: string,
  log: Logger
): Promise<string> {
  const token = await getAccessToken(log);

  // Try to create — if it already exists Box returns 409 with the existing folder info
  const resp = await boxApiFetch(
    "https://api.box.com/2.0/folders",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        parent: { id: parentFolderId },
      }),
    },
    log
  );

  if (resp.ok) {
    const data = (await resp.json()) as { id: string };
    log.info(`Created Box subfolder "${folderName}" → ${data.id}`);
    return data.id;
  }

  if (resp.status === 409) {
    // Folder already exists — extract ID from conflict info
    const conflict = (await resp.json()) as {
      context_info?: { conflicts?: Array<{ id: string }> };
    };
    const existing = conflict.context_info?.conflicts?.[0];
    if (existing) {
      log.info(`Box subfolder "${folderName}" already exists → ${existing.id}`);
      return existing.id;
    }
  }

  const text = await resp.text();
  throw new Error(`Box create folder failed (${resp.status}): ${text}`);
}

// ── Upload ──────────────────────────────────────────────────────────────────

/**
 * Build a multipart/form-data body manually for streaming upload.
 *
 * We construct the multipart envelope by hand so we can pipe the file
 * stream directly rather than buffering it in memory.
 *
 * VERCEL LIMIT: Although we stream, Vercel functions have a max execution
 * time (10s on Hobby, 60s on Pro, 300s on Enterprise) and request/response
 * body limits (~4.5–50 MB depending on plan). Files exceeding these limits
 * will fail. For production use with very large files, consider an external
 * worker or chunked upload via Box's session-based upload API.
 */
export async function uploadFile(
  folderId: string,
  fileName: string,
  fileStream: NodeJS.ReadableStream,
  fileSize: number | null,
  log: Logger
): Promise<BoxFile> {
  const token = await getAccessToken(log);
  const boundary = `----BoxUpload${crypto.randomBytes(16).toString("hex")}`;

  // Build the multipart preamble with the "attributes" part and the
  // beginning of the file part.
  const attributes = JSON.stringify({
    name: fileName,
    parent: { id: folderId },
  });

  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="attributes"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${attributes}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
  );

  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);

  // Collect file stream into buffer. On Vercel we cannot use a true
  // passthrough stream with node-fetch v2 for chunked uploads because
  // the Content-Length must be known and Vercel's infrastructure does
  // not support Transfer-Encoding: chunked for outbound requests from
  // serverless functions. We keep memory pressure manageable by
  // constraining to files that fit within Vercel's limits.
  const chunks: Buffer[] = [];
  for await (const chunk of fileStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const fileBuffer = Buffer.concat(chunks);

  const body = Buffer.concat([preamble, fileBuffer, epilogue]);

  const resp = await boxApiFetch(
    "https://upload.box.com/api/2.0/files/content",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    },
    log
  );

  // 409 → file with same name exists — upload as new version
  if (resp.status === 409) {
    const conflict = (await resp.json()) as {
      context_info?: { conflicts?: { id: string } };
    };
    const existingId = conflict.context_info?.conflicts?.id;
    if (existingId) {
      log.info(`Box file "${fileName}" already exists (${existingId}), uploading new version`);
      return uploadNewVersion(existingId, fileName, fileBuffer, log);
    }
    const text = JSON.stringify(conflict);
    throw new Error(`Box upload 409 conflict: ${text}`);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Box upload failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as { entries: BoxUploadEntry[] };
  const entry = data.entries[0];
  if (!entry) throw new Error("Box upload returned no entries");

  log.info(`Uploaded to Box: ${entry.name} → ${entry.id}`);

  return {
    id: entry.id,
    name: entry.name,
    sharedLink: entry.shared_link?.url ?? null,
  };
}

/**
 * Upload a new version of an existing Box file.
 * Uses the Box Upload New Version API: POST /files/:id/content
 */
async function uploadNewVersion(
  fileId: string,
  fileName: string,
  fileBuffer: Buffer,
  log: Logger
): Promise<BoxFile> {
  const token = await getAccessToken(log);
  const boundary = `----BoxVersion${crypto.randomBytes(16).toString("hex")}`;

  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([preamble, fileBuffer, epilogue]);

  const resp = await boxApiFetch(
    `https://upload.box.com/api/2.0/files/${fileId}/content`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    },
    log
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Box version upload failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as { entries: BoxUploadEntry[] };
  const entry = data.entries[0];
  if (!entry) throw new Error("Box version upload returned no entries");

  log.info(`Uploaded new version to Box: ${entry.name} → ${entry.id}`);
  return {
    id: entry.id,
    name: entry.name,
    sharedLink: entry.shared_link?.url ?? null,
  };
}

// ── Shared links ────────────────────────────────────────────────────────────

/**
 * Create a shared link on a Box file.
 * Returns the shared link URL, or null if access level is not configured.
 */
export async function createSharedLink(
  fileId: string,
  log: Logger
): Promise<string | null> {
  const cfg = getBoxConfig();
  if (!cfg.sharedLinkAccess) {
    log.info(`Skipping shared link for file ${fileId} (no access level set)`);
    return null;
  }

  const token = await getAccessToken(log);

  const resp = await boxApiFetch(
    `https://api.box.com/2.0/files/${fileId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shared_link: {
          access: cfg.sharedLinkAccess,
        },
      }),
    },
    log
  );

  if (!resp.ok) {
    const text = await resp.text();
    log.warn(`Failed to create shared link for ${fileId}: ${resp.status} ${text}`);
    return null;
  }

  const data = (await resp.json()) as {
    shared_link?: { url: string } | null;
  };

  const url = data.shared_link?.url ?? null;
  if (url) {
    log.info(`Shared link for ${fileId}: ${url}`);
  }
  return url;
}

// ── File naming ─────────────────────────────────────────────────────────────

/**
 * Build a standardized file name.
 *
 * Format: CompanyCode_CompanyName_YYYY-MM-DD_[targetYearMonth_]fieldName.ext
 *
 * When targetYearMonth is provided:
 *   6_1_株式会社アンドパッド_2026-03-10_2026年3月_PL・誓約書.pdf
 *
 * When targetYearMonth is absent:
 *   6_1_株式会社アンドパッド_2026-03-10_PL・誓約書.pdf
 */
export function buildFileName(
  companyCode: string,
  fieldName: string,
  originalName: string,
  indexInField?: number,
  options?: {
    companyNameJp?: string;
    targetYearMonth?: string;
  }
): string {
  const dotIdx = originalName.lastIndexOf(".");
  const ext = dotIdx >= 0 ? originalName.slice(dotIdx) : "";

  const safeField = fieldName.replace(/[/\\:*?"<>|]/g, "_");
  const suffix = indexInField !== undefined && indexInField > 0 ? `_${indexInField + 1}` : "";
  const date = new Date().toISOString().slice(0, 10);

  const parts = [companyCode];
  if (options?.companyNameJp) {
    parts.push(options.companyNameJp.replace(/[/\\:*?"<>|]/g, "_"));
  }
  parts.push(date);
  if (options?.targetYearMonth) {
    parts.push(options.targetYearMonth.replace(/[/\\:*?"<>|]/g, "_"));
  }
  parts.push(`${safeField}${suffix}`);

  return `${parts.join("_")}${ext}`;
}

/**
 * Get YYYY-MM subfolder name for the current date.
 */
export function getMonthFolder(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
