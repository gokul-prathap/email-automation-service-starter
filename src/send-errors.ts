export interface SendFailure {
  kind: "pre-send" | "rejected" | "ambiguous";
  retryable: boolean;
  code: string;
  httpStatus?: number;
  retryAfterMs: number;
}

export function classifyFailure(error: unknown, submitted: boolean, now = Date.now()): SendFailure {
  // Never persist raw Gaxios errors: request configs can contain OAuth credentials.
  const e = error as any;
  const status = Number(e?.response?.status) || undefined;
  const reasons: string[] = (e?.response?.data?.error?.errors ?? []).map((x: any) => x.reason);
  const raw = e?.response?.headers?.get?.("retry-after") ?? e?.response?.headers?.["retry-after"];
  const seconds = raw === undefined ? NaN : Number(raw);
  const retryAfterMs = raw === undefined ? 0 : Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
    : Math.max(0, Date.parse(String(raw)) - now) || 0;
  if (!submitted) return { kind: "pre-send", retryable: true, code: "PREPARATION_FAILED", retryAfterMs };
  const rateLimited = status === 429 || (status === 403 && reasons.some(r =>
    ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"].includes(r)));
  if (rateLimited) return { kind: "rejected", retryable: true, code: "GMAIL_RATE_LIMIT", httpStatus: status, retryAfterMs };
  if (status && [400, 401, 403, 404, 413, 422].includes(status)) {
    return { kind: "rejected", retryable: false, code: "GMAIL_REJECTED", httpStatus: status, retryAfterMs };
  }
  // Network errors, timeouts, 408 and 5xx may occur after acceptance. Do not resend.
  return { kind: "ambiguous", retryable: false, code: "SUBMISSION_UNCERTAIN", httpStatus: status, retryAfterMs };
}
