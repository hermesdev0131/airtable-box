import { Request } from "express";

const AIRTABLE_RECORD_ID_RE = /^rec[a-zA-Z0-9]{14}$/;

export interface WebhookPayload {
  recordId: string;
  tableName?: string;
  secret?: string;
}

export interface ValidationResult {
  ok: true;
  payload: WebhookPayload;
}

export interface ValidationError {
  ok: false;
  status: number;
  message: string;
}

/**
 * Validates the incoming webhook request:
 * - Checks secret from body or x-webhook-secret header
 * - Validates recordId format (recXXXXXXXXXXXXXX)
 */
export function validateWebhook(
  req: Request,
  webhookSecret: string
): ValidationResult | ValidationError {
  const body = req.body as Record<string, unknown> | undefined;

  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, message: "Missing JSON body" };
  }

  // Authenticate: secret in body OR in header
  const incomingSecret =
    (typeof body.secret === "string" ? body.secret : undefined) ||
    (typeof req.headers["x-webhook-secret"] === "string"
      ? (req.headers["x-webhook-secret"] as string)
      : undefined);

  if (!incomingSecret || incomingSecret !== webhookSecret) {
    return { ok: false, status: 401, message: "Invalid or missing secret" };
  }

  // Validate recordId
  const recordId = body.recordId;
  if (typeof recordId !== "string" || !AIRTABLE_RECORD_ID_RE.test(recordId)) {
    return {
      ok: false,
      status: 400,
      message:
        "Invalid recordId. Expected format: recXXXXXXXXXXXXXX (rec + 14 alphanumeric chars)",
    };
  }

  const tableName =
    typeof body.tableName === "string" ? body.tableName : undefined;

  return {
    ok: true,
    payload: { recordId, tableName, secret: "[REDACTED]" },
  };
}
