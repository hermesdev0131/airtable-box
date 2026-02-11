import {
  AirtableRecord,
  getAttachments,
  getExistingBoxIds,
  getExistingBoxLinks,
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
  /** If already fully uploaded, the message explaining why we skip */
  skipReason?: string;
  /** Attachment filenames that already have a Box ID (partial upload) */
  alreadyUploadedFileNames: Set<string>;
  /** Existing Box IDs from the record */
  existingBoxIds: string[];
  /** Existing Box links from the record */
  existingBoxLinks: string[];
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
 * 4. If status is "Pending" or "Failed", we should process.
 * 5. Atomically set status to "Processing" (best-effort lock via PATCH).
 * 6. Check for partial uploads: compare attachment count with existing Box IDs.
 */
export async function checkIdempotency(
  recordId: string,
  log: Logger,
  tableName?: string
): Promise<IdempotencyCheck> {
  log.info("Checking idempotency");

  const record = await getRecord(recordId, log, tableName);
  const status = getStatus(record);
  const attachments = getAttachments(record);
  const existingBoxIds = getExistingBoxIds(record);
  const existingBoxLinks = getExistingBoxLinks(record);

  // Already fully uploaded
  if (status === "Uploaded" && existingBoxIds.length >= attachments.length) {
    log.info("Record already fully uploaded, skipping");
    return {
      shouldProcess: false,
      record,
      skipReason: "Already uploaded",
      alreadyUploadedFileNames: new Set(),
      existingBoxIds,
      existingBoxLinks,
    };
  }

  // Another invocation is already processing
  if (status === "Processing") {
    log.info("Record is currently being processed by another invocation, skipping");
    return {
      shouldProcess: false,
      record,
      skipReason: "Already processing",
      alreadyUploadedFileNames: new Set(),
      existingBoxIds,
      existingBoxLinks,
    };
  }

  // Determine which files were already uploaded (partial completion).
  // We match by counting: Box IDs are stored in order of attachment index.
  // For a more robust approach, the file names stored in Box include the
  // original attachment filename, so we can also cross-reference.
  const alreadyUploadedFileNames = new Set<string>();
  // Box IDs list is ordered by attachment order. If we have N box IDs and
  // N attachments of which the first N are done, mark those.
  // This is a heuristic — the webhook handler will do a final check per file.
  for (let i = 0; i < existingBoxIds.length && i < attachments.length; i++) {
    if (existingBoxIds[i]) {
      alreadyUploadedFileNames.add(attachments[i].filename);
    }
  }

  // Acquire lock: set status to Processing
  log.info(`Acquiring lock: setting status from "${status}" to "Processing"`);
  await setStatus(recordId, "Processing", log);

  return {
    shouldProcess: true,
    record,
    alreadyUploadedFileNames,
    existingBoxIds,
    existingBoxLinks,
  };
}
