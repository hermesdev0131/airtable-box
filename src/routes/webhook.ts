import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../utils/logger";
import { validateWebhook } from "../utils/validation";
import { checkIdempotency } from "../services/idempotency";
import {
  downloadAttachmentStream,
  getAllAttachments,
  getCompanyCode,
  getCompanyNameJp,
  getFundName,
  getSubmissionPeriod,
  setStatus,
  writeBoxResult,
} from "../services/airtable";
import {
  buildFileName,
  createSharedLink,
  ensureSubfolder,
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
  const attachments = getAllAttachments(record);

  if (attachments.length === 0) {
    rlog.info("No attachments found, marking as Uploaded");
    await writeBoxResult(recordId, "", rlog);
    return;
  }

  // ── Extract fund, company, and period info ─────────────────────────────
  const fundName = getFundName(record);
  if (!fundName) {
    throw new Error(
      "Fund field is empty — cannot determine target folder. " +
        "Ensure the lookup field is configured on the ドキュメント収集管理 table."
    );
  }

  const companyCode = getCompanyCode(record);
  if (!companyCode) {
    throw new Error(
      "CompanyCode field is empty — cannot build filename. " +
        "Ensure the lookup field is configured on the ドキュメント収集管理 table."
    );
  }

  const companyNameJp = getCompanyNameJp(record);
  if (!companyNameJp) {
    throw new Error(
      "Company Name (JP) field is empty — cannot create subfolder. " +
        "Ensure the lookup field is configured on the ドキュメント収集管理 table."
    );
  }

  const submissionPeriod = getSubmissionPeriod(record);
  if (!submissionPeriod) {
    throw new Error("提出期間 field is empty — cannot create subfolder.");
  }

  rlog.info(
    `Found ${attachments.length} attachment(s) ` +
      `(fund: ${fundName}, company: ${companyNameJp} [${companyCode}], period: ${submissionPeriod})`
  );

  // ── Ensure target subfolders: Fund → Company → Period ─────────────────
  // Structure: BOX_TARGET_FOLDER_ID / 4号 / ABC123_サンプル株式会社 / Q1 2025 / files
  const targetFolderId = process.env.BOX_TARGET_FOLDER_ID;
  if (!targetFolderId) throw new Error("BOX_TARGET_FOLDER_ID not set");

  const fundFolderId = await ensureSubfolder(targetFolderId, fundName, rlog);

  // Sanitize folder names for Box
  const companyFolderName = `${companyCode}_${companyNameJp}`.replace(
    /[/\\:*?"<>|]/g,
    "_"
  );
  const companyFolderId = await ensureSubfolder(
    fundFolderId,
    companyFolderName,
    rlog
  );

  const periodFolderName = submissionPeriod.replace(/[/\\:*?"<>|]/g, "_");
  const uploadFolderId = await ensureSubfolder(
    companyFolderId,
    periodFolderName,
    rlog
  );

  // ── Process each attachment ─────────────────────────────────────────────
  // Track how many files per field for index suffix (when multiple files in one field)
  const fieldFileCount = new Map<string, number>();
  let uploadedCount = 0;

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const indexInField = fieldFileCount.get(att.fieldName) ?? 0;
    fieldFileCount.set(att.fieldName, indexInField + 1);

    rlog.info(
      `Processing attachment ${i + 1}/${attachments.length}: ` +
        `[${att.fieldName}] ${att.filename} (${att.size} bytes)`
    );

    // Build the target file name: CompanyCode_YYYY-MM-DD_fieldName.ext
    const boxFileName = buildFileName(
      companyCode,
      att.fieldName,
      att.filename,
      indexInField
    );

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
    if (!boxFile.sharedLink) {
      await createSharedLink(boxFile.id, rlog);
    }

    uploadedCount++;
    rlog.info(
      `Attachment ${i + 1}/${attachments.length} done: ${boxFileName} → Box ID ${boxFile.id}`
    );
  }

  // ── Final write ─────────────────────────────────────────────────────────
  const boxFolderUrl = `https://app.box.com/folder/${uploadFolderId}`;
  await writeBoxResult(recordId, boxFolderUrl, rlog);
  rlog.info(
    `Processing complete: ${uploadedCount} file(s) uploaded to Box → ${boxFolderUrl}`
  );
}

// ── Health check ────────────────────────────────────────────────────────────

router.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

export default router;
