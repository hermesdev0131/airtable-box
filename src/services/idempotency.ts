import {
  AirtableRecord,
  getRecord,
  getStatus,
  setStatus,
} from "./airtable";
import { Logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IdempotencyCheck {
  /** Whether we should proceed with processing */
  shouldProcess: boolean;
  /** The fresh Airtable record (always fetched) */
  record: AirtableRecord;
  /** If skipping, the reason */
  skipReason?: string;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Idempotency gate: determines whether this webhook invocation should
 * proceed with processing.
 *
 * Logic:
 * 1. Fetch the record from Airtable (source of truth).
 * 2. If status is "Uploaded", all work is done → skip.
 * 3. If status is "Processing", another invocation is active → skip.
 * 4. If status is "Pending" or "Failed" or empty, we should process.
 * 5. Set status to "Processing" (best-effort lock via PATCH).
 */
export async function checkIdempotency(
  recordId: string,
  log: Logger,
  tableName?: string
): Promise<IdempotencyCheck> {
  log.info("Checking idempotency");

  const record = await getRecord(recordId, log, tableName);
  const status = getStatus(record);

  // Already fully uploaded
  if (status === "Uploaded") {
    log.info("Record already fully uploaded, skipping");
    return {
      shouldProcess: false,
      record,
      skipReason: "Already uploaded",
    };
  }

  // Another invocation is already processing
  if (status === "Processing") {
    log.info("Record is currently being processed by another invocation, skipping");
    return {
      shouldProcess: false,
      record,
      skipReason: "Already processing",
    };
  }

  // Acquire lock: set status to Processing
  log.info(`Acquiring lock: setting status from "${status}" to "Processing"`);
  await setStatus(recordId, "Processing", log);

  return {
    shouldProcess: true,
    record,
  };
}
