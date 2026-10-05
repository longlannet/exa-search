export const ERROR_MESSAGES = Object.freeze({
  RATE_LIMITED: "Exa rate limit reached; wait before trying again.",
  AUTH_REQUIRED: "Exa authentication required; authenticated connections are disabled.",
  NETWORK_ERROR: "Exa network connection failed; check connectivity and try again later.",
  REMOTE_ERROR: "Exa returned a remote service error.",
  PROTOCOL_ERROR: "Exa returned an invalid or unsupported MCP response.",
  INPUT_LIMIT: "Exa MCP session response exceeded the 8 MiB input limit",
  SCHEMA_MISMATCH: "Exa tool schema is incompatible with this skill.",
  CONFIG_ERROR: "Exa configuration is unsafe or unsupported.",
  INVALID_ARGUMENT: "Exa arguments are invalid; check the documented limits.",
  DEPENDENCY_ERROR: "Exa runtime dependencies are missing or do not match the lockfile.",
  TIMEOUT: "Exa operation exceeded its deadline.",
  OUTPUT_LIMIT: "Exa output exceeded its limit or was truncated.",
  INTERRUPTED: "Exa operation was interrupted.",
  PROCESS_ERROR: "Exa helper process failed.",
});
const HTTP_RETRY_CODES = new Set(["RATE_LIMITED", "REMOTE_ERROR"]);
const NETWORK_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
function knownCode(code) { return typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code); }
function validStatus(value) { return Number.isInteger(value) && value >= 100 && value <= 599; }
function validRetry(value) { return Number.isSafeInteger(value) && value >= 0; }
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export class ExaError extends Error {
  constructor(code, { status, retryAfterSeconds, cause } = {}) {
    const safeCode = knownCode(code) ? code : "PROCESS_ERROR";
    super(ERROR_MESSAGES[safeCode], cause === undefined ? undefined : { cause });
    this.name = "ExaError";
    this.code = safeCode;
    if (validStatus(status)) this.status = status;
    if (HTTP_RETRY_CODES.has(safeCode) && validRetry(retryAfterSeconds)) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== "string" || value.length > 128 || !Number.isFinite(nowMs)) return undefined;
  const text = value.replace(/^[ \t]+|[ \t]+$/g, "");
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return validRetry(seconds) ? seconds : undefined;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    return undefined;
  }
  const instant = Date.parse(text);
  if (!Number.isFinite(instant) || new Date(instant).toUTCString() !== text) return undefined;
  const seconds = Math.max(0, Math.ceil((instant - nowMs) / 1000));
  return validRetry(seconds) ? seconds : undefined;
}

export function httpError(status, retryAfter, nowMs = Date.now()) {
  if (!validStatus(status) || status < 300) return new ExaError("PROTOCOL_ERROR");
  return new ExaError(status === 401 || status === 403 ? "AUTH_REQUIRED" : status === 429 ? "RATE_LIMITED" : "REMOTE_ERROR", {
    status, retryAfterSeconds: parseRetryAfter(retryAfter, nowMs),
  });
}

export function classifyError(error, fallbackCode = "PROCESS_ERROR") {
  const visited = new Set();
  for (let current = error, depth = 0; current && depth < 8 && !visited.has(current); current = current.cause, depth += 1) {
    visited.add(current);
    if (current instanceof ExaError) return current;
    if (current.code === -32001 || current.name === "TimeoutError" || TIMEOUT_CODES.has(current.code)) {
      return new ExaError("TIMEOUT", { cause: error });
    }
    if (NETWORK_CODES.has(current.code)) return new ExaError("NETWORK_ERROR", { cause: error });
    if (current.name === "AbortError") return new ExaError("INTERRUPTED", { cause: error });
    if (current instanceof SyntaxError || current.name === "ZodError" ||
        Number.isInteger(current.code)) {
      return new ExaError("PROTOCOL_ERROR", { cause: error });
    }
  }
  return new ExaError(fallbackCode, { cause: error });
}

export function errorDiagnostic(error, fallbackCode = "PROCESS_ERROR") {
  const classified = classifyError(error, fallbackCode);
  const code = knownCode(classified.code) ? classified.code : "PROCESS_ERROR";
  const diagnostic = { code, message: ERROR_MESSAGES[code] };
  if (validStatus(classified.status)) diagnostic.http_status = classified.status;
  if (HTTP_RETRY_CODES.has(code) && validRetry(classified.retryAfterSeconds)) {
    diagnostic.retry_after_seconds = classified.retryAfterSeconds;
  }
  return { type: "exa-search-error", version: 1, error: diagnostic };
}

export function renderDiagnostic(record) {
  if (!plainObject(record) || Object.keys(record).length !== 3 || record.type !== "exa-search-error" || record.version !== 1 ||
      !["type", "version", "error"].every((key) => Object.hasOwn(record, key)) || !plainObject(record.error)) return null;
  const value = record.error;
  if (!knownCode(value.code) || typeof value.message !== "string" ||
      !Object.hasOwn(value, "code") || !Object.hasOwn(value, "message") ||
      Object.keys(value).some((key) => !["code", "message", "http_status", "retry_after_seconds"].includes(key))) return null;
  if (Object.hasOwn(value, "http_status") && !validStatus(value.http_status)) return null;
  if (Object.hasOwn(value, "retry_after_seconds") &&
      (!HTTP_RETRY_CODES.has(value.code) || !validRetry(value.retry_after_seconds))) return null;
  const retry = Object.hasOwn(value, "retry_after_seconds") ? `; retry_after_seconds=${value.retry_after_seconds}` : "";
  return `[exa-search] ERROR [${value.code}]: ${ERROR_MESSAGES[value.code]}${retry}`;
}

export function writeError(error, fallbackCode = "PROCESS_ERROR") {
  const diagnostic = errorDiagnostic(error, fallbackCode);
  const escaped = String(error?.message ?? error).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (value) => `\\x${value.charCodeAt(0).toString(16).padStart(2, "0")}`);
  let detail = "";
  let bytes = 0;
  for (const character of escaped) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > 512) break;
    detail += character;
  }
  process.stderr.write(`${JSON.stringify(diagnostic)}\n[exa-search] ERROR: ${detail}\n`);
}
