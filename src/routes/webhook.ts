import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../utils/logger";
import { validateWebhook } from "../utils/validation";
import { checkIdempotency } from "../services/idempotency";
import {
  downloadAttachmentStream,
  getAttachments,
  setStatus,
  writeBoxResults,
} from "../services/airtable";
import {
  buildFileName,
  createSharedLink,
  ensureSubfolder,
  getMonthFolder,
  uploadFile,
  BoxFile,
} from "../services/box";

const router = Router();

// ── POST /webhook ───────────────────────────────────────────────────────────

router.post("/webhook", async (req: Request, res: Response) => {
  const requestId = uuidv4();
  const log = createLogger({ requestId });

  // ── Validate ────────────────────────────────────────────────────────────
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    log.error("WEBHOOK_SECRET not configured");
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }

  const validation = validateWebhook(req, webhookSecret);
  if (!validation.ok) {
    log.warn(`Validation failed: ${validation.message}`);
    res.status(validation.status).json({ error: validation.message });
    return;
  }

  const { recordId, tableName } = validation.payload;
  log.info(`Webhook received for record ${recordId}`);

  // ── Respond early ───────────────────────────────────────────────────────
  // On Vercel, the function keeps running after res.json() until the
  // handler's returned Promise resolves or the execution time limit is hit.
  // Vercel's Node.js runtime waits for the handler to finish before
  // terminating the invocation. We respond with 200 immediately so the
  // caller (Airtable Automation) does not time out, then continue
  // processing in the same execution context.
  //
  // IMPORTANT: If execution time exceeds Vercel's limit (10s Hobby,
  // 60s Pro, 300s Enterprise), the function will be killed mid-flight.
  // For very large files, consider an external queue or Vercel Cron.
  res.status(200).json({
    ok: true,
    requestId,
    recordId,
    message: "Processing started",
  });

  // ── Process asynchronously (same execution context) ─────────────────────
  try {
    await processRecord(recordId, requestId, tableName, log);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Unhandled error processing ${recordId}: ${msg}`);
    // Best-effort: mark as Failed in Airtable
    try {
      await setStatus(recordId, "Failed", log, msg);
    } catch (statusErr: unknown) {
      const statusMsg =
        statusErr instanceof Error ? statusErr.message : String(statusErr);
      log.error(`Failed to set Failed status: ${statusMsg}`);
    }
  }
});

// ── Core processing logic ───────────────────────────────────────────────────

async function processRecord(
  recordId: string,
  requestId: string,
  tableName: string | undefined,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const rlog = log.child({ recordId });

  // ── Idempotency check ───────────────────────────────────────────────────
  const idem = await checkIdempotency(recordId, rlog, tableName);
  if (!idem.shouldProcess) {
    rlog.info(`Skipping: ${idem.skipReason}`);
    return;
  }

  const record = idem.record;
  const attachments = getAttachments(record);

  if (attachments.length === 0) {
    rlog.info("No attachments found, marking as Uploaded");
    await writeBoxResults(recordId, [], [], rlog);
    return;
  }

  rlog.info(`Found ${attachments.length} attachment(s) to process`);

  // ── Ensure target subfolder (YYYY-MM) ───────────────────────────────────
  const targetFolderId = process.env.BOX_TARGET_FOLDER_ID;
  if (!targetFolderId) throw new Error("BOX_TARGET_FOLDER_ID not set");

  const monthFolder = getMonthFolder();
  const uploadFolderId = await ensureSubfolder(
    targetFolderId,
    monthFolder,
    rlog
  );

  // ── Process each attachment ─────────────────────────────────────────────
  // Carry forward any already-uploaded results (partial completion support)
  const boxIds: string[] = [...idem.existingBoxIds];
  const boxLinks: string[] = [...idem.existingBoxLinks];

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];

    // Skip if already uploaded (idempotency for partial completion)
    if (idem.alreadyUploadedFileNames.has(att.filename) && boxIds[i]) {
      rlog.info(
        `Skipping already-uploaded attachment ${i + 1}/${attachments.length}: ${att.filename}`
      );
      continue;
    }

    rlog.info(
      `Processing attachment ${i + 1}/${attachments.length}: ${att.filename} (${att.size} bytes)`
    );

    // Build the target file name
    const boxFileName = buildFileName(recordId, att.filename);

    // Download from Airtable CDN
    const { stream, contentLength } = await downloadAttachmentStream(
      att.url,
      rlog
    );

    rlog.info(
      `Downloaded stream ready, content-length: ${contentLength ?? "unknown"}`
    );

    // Upload to Box
    let boxFile: BoxFile;
    try {
      boxFile = await uploadFile(
        uploadFolderId,
        boxFileName,
        stream,
        contentLength,
        rlog
      );
    } catch (uploadErr: unknown) {
      const msg =
        uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
      rlog.error(`Upload failed for ${att.filename}: ${msg}`);
      throw uploadErr;
    }

    // Create shared link if configured
    let sharedLinkUrl = boxFile.sharedLink;
    if (!sharedLinkUrl) {
      sharedLinkUrl = await createSharedLink(boxFile.id, rlog);
    }

    // Store results (maintain positional alignment with attachments)
    boxIds[i] = boxFile.id;
    boxLinks[i] = sharedLinkUrl || `https://app.box.com/file/${boxFile.id}`;

    rlog.info(
      `Attachment ${i + 1}/${attachments.length} done: Box ID ${boxFile.id}`
    );

    // Write intermediate results after each file so partial progress is saved
    await writeIntermediateResults(recordId, boxIds, boxLinks, rlog);
  }

  // ── Final write ─────────────────────────────────────────────────────────
  // Filter out any empty entries from sparse array
  const finalIds = boxIds.filter(Boolean);
  const finalLinks = boxLinks.filter(Boolean);

  await writeBoxResults(recordId, finalIds, finalLinks, rlog);
  rlog.info(
    `Processing complete: ${finalIds.length} file(s) uploaded to Box`
  );
}

/**
 * Write intermediate results to Airtable after each file upload.
 * This preserves partial progress if the function is killed mid-flight.
 * Status stays as "Processing" — only the final write sets "Uploaded".
 */
async function writeIntermediateResults(
  recordId: string,
  boxIds: string[],
  boxLinks: string[],
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const { updateRecord } = await import("../services/airtable");
  const { getAirtableConfig } = await import("../services/airtable");
  const cfg = getAirtableConfig();

  await updateRecord(
    recordId,
    {
      [cfg.boxIdsField]: boxIds.filter(Boolean).join("\n"),
      [cfg.boxLinksField]: boxLinks.filter(Boolean).join("\n"),
    },
    log
  );
}

// ── Health check ────────────────────────────────────────────────────────────

router.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

export default router;
