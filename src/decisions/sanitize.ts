/**
 * Untrusted Input Sanitization & Normalization
 *
 * Provides string sanitization for untrusted contributor text (PR/issue titles and bodies):
 * - Strips ANSI terminal escape sequences and non-printable control characters
 * - Normalizes Unicode (NFC)
 * - Redacts credential patterns (Bearer tokens, GitHub PATs, common API keys)
 * - Enforces clean length bounds with truncation markers
 * - Wraps untrusted text in structured state objects
 * - Computes deterministic SHA-256 state fingerprints for cache identity & audit provenance
 *
 * Note: String sanitization mitigates terminal hazards, row injections, and token blow-ups,
 * but does not claim complete semantic immunity against adversarial prompt manipulation.
 */
import { createHash } from "node:crypto";
import type { PRItem } from "../types.js";

// Strip ANSI escape sequences: CSI, OSC, etc.
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// Strip control characters except standard whitespace (\t, \n, \r)
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// Redact credential patterns such as Bearer tokens, GitHub PATs, and common API key formats
const SENSITIVE_PATTERNS = [
  /Bearer\s+([A-Za-z0-9_\-.]{10,})/gi,
  /(gh[pousr]_[A-Za-z0-9_]{20,})/g,
  /(typesafe_[A-Za-z0-9_]{16,})/gi,
  /(sk-[A-Za-z0-9_-]{20,})/g,
];

export interface SanitizeOptions {
  maxTitleLength?: number;
  maxBodyLength?: number;
  redactSecrets?: boolean;
}

const DEFAULT_MAX_TITLE = 500;
const DEFAULT_MAX_BODY = 16000;

/**
 * Clean untrusted strings by stripping ANSI codes, control characters,
 * redacting credential-like patterns, and cleanly bounding length.
 */
export function sanitizeUntrustedText(
  raw: string | undefined | null,
  maxLength = DEFAULT_MAX_BODY,
  redactSecrets = true,
): string {
  if (!raw) return "";
  let text = String(raw).replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");

  if (redactSecrets) {
    for (const pattern of SENSITIVE_PATTERNS) {
      text = text.replace(pattern, "[REDACTED_SECRET]");
    }
  }

  // Normalize Unicode
  text = text.normalize("NFC");

  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}\n[...truncated for decision context]`;
  }

  return text.trim();
}

export interface SanitizedItemState {
  repo: string;
  number: number;
  type: "pr" | "issue";
  title: string;
  body: string;
  author: string;
  state: string;
  labels: string[];
  ciStatus?: string;
  hasTests?: boolean;
  additions?: number;
  deletions?: number;
}

/**
 * Prepares an untrusted PR/issue item into a safe, bounded, structured state
 * suitable for System One model evaluation.
 */
export function sanitizeItemForDecision(item: PRItem, opts: SanitizeOptions = {}): SanitizedItemState {
  const maxTitle = opts.maxTitleLength ?? DEFAULT_MAX_TITLE;
  const maxBody = opts.maxBodyLength ?? DEFAULT_MAX_BODY;
  const redact = opts.redactSecrets ?? true;

  return {
    repo: sanitizeUntrustedText(item.repo, 200, false),
    number: Number.isInteger(item.number) ? item.number : 0,
    type: item.type === "pr" ? "pr" : "issue",
    title: sanitizeUntrustedText(item.title, maxTitle, redact),
    body: sanitizeUntrustedText(item.body, maxBody, redact),
    author: sanitizeUntrustedText(item.author, 100, false),
    state: sanitizeUntrustedText(item.state, 50, false),
    labels: Array.isArray(item.labels)
      ? item.labels.map((l) => sanitizeUntrustedText(l, 100, false)).filter(Boolean)
      : [],
    ciStatus: item.ciStatus,
    hasTests: item.hasTests,
    additions: item.additions,
    deletions: item.deletions,
  };
}

/**
 * Computes a deterministic SHA-256 hex digest of the canonicalized state.
 */
export function computeStateHash(state: Record<string, unknown> | string): string {
  const normalized = typeof state === "string" ? state : JSON.stringify(sortKeys(state));
  return createHash("sha256").update(normalized).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}
