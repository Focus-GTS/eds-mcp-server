/**
 * Error formatting utilities for the EDS MCP server.
 *
 * Follows the same pattern used by Adobe's da-mcp server: structured API
 * errors are surfaced with status + message + details, while generic and
 * unknown errors are normalised into a consistent string representation.
 */

interface ApiError {
  status?: number;
  message?: string;
  details?: string;
  url?: string;
}

/**
 * A typed error carrying the HTTP status from an EDS Admin/Content API call, so
 * callers and {@link formatError} can react to the status (401 → re-login,
 * 429 → rate limited, etc.) rather than string-matching a message.
 */
export class EdsApiError extends Error {
  readonly status: number;
  readonly url?: string;
  readonly details?: string;

  constructor(
    status: number,
    message: string,
    opts?: { url?: string; details?: string },
  ) {
    super(message);
    this.name = 'EdsApiError';
    this.status = status;
    this.url = opts?.url;
    this.details = opts?.details;
  }
}

/**
 * True only for structured API errors — a numeric `status` or a `details`
 * string. Deliberately does NOT match on `message` alone: every `Error` has a
 * string message, so matching it would swallow plain errors (e.g. a `fetch`
 * failure whose real cause lives on `error.cause`) into branch 1 and drop the
 * cause. See {@link formatError} branch 2.
 */
function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.status === 'number' || typeof obj.details === 'string';
}

/**
 * Convert any thrown value into a human-readable error string suitable for
 * returning to the MCP client.
 *
 * Handles three categories:
 * 1. Typed API errors with `status`, `message`, and/or `details` fields.
 * 2. Standard `Error` instances (or subclasses).
 * 3. Arbitrary unknown values (stringified as a fallback).
 */
export function formatError(error: unknown): string {
  // 1. Structured API error (e.g. from an EDS Admin API fetch wrapper)
  if (isApiError(error)) {
    const parts: string[] = [];

    if (error.status !== undefined) {
      parts.push(`[${error.status}]`);
    }

    if (error.message) {
      parts.push(error.message);
    }

    if (error.details) {
      parts.push(`— ${error.details}`);
    }

    if (error.url) {
      parts.push(`(${error.url})`);
    }

    if (parts.length > 0) {
      return parts.join(' ');
    }
  }

  // 2. Standard Error objects
  if (error instanceof Error) {
    const base = error.message || error.name || 'Unknown error';
    if (error.cause instanceof Error) {
      return `${base}: ${error.cause.message}`;
    }
    return base;
  }

  // 3. Anything else — coerce to string
  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
