/**
 * VENDORED from gp-foundry (MIT, Copyright (c) 2026 The General Partnership).
 * Source: https://github.com/thegpvc/gp-foundry/blob/a1dca903c879250d1f598c90d47eebafc1c2e5ee/actions/sanitize-untrusted-input/src/sanitize.ts
 * Commit: a1dca903c879250d1f598c90d47eebafc1c2e5ee
 * License: see packages/sanitize/NOTICE.
 *
 * Changes from upstream (globalhost, ADR-0001):
 *   - Invisible-character classes written as \u escapes instead of raw
 *     characters, and widened: Unicode tag block (ASCII smuggling), variation
 *     selectors, invisible math operators, Hangul fillers, interlinear
 *     annotation chars, combining grapheme joiner, U+2028/U+2029 -> "\n".
 *   - stripControlChars takes the normalization form (we default to NFKC, which
 *     folds fullwidth/mathematical lookalikes) and strips both before and after
 *     normalizing.
 *   - maskSecrets replaces with `[REDACTED:<kind>]` per rule, keeps the key and
 *     separator in `KEY=value` matches, splits Anthropic/OpenAI keys, catches
 *     unterminated private-key blocks and JSON-quoted keys.
 *   - capLength takes the marker text from the caller.
 *   - Removed: SanitizeConfig/resolveConfig, chooseFence/fenceContent and the
 *     sanitize() pipeline. Our pipeline and `<untrusted>` fence live in
 *     ../untrusted.ts. neutralizeInjection is kept as an opt-in layer.
 *
 * Original header follows.
 *
 * sanitize-untrusted-input (C5) - gp-foundry runtime-core action.
 *
 * SECURITY-CRITICAL. Neutralizes prompt-injection in attacker-controlled text
 * (issue/PR/comment bodies) before it is ever concatenated into an LLM prompt.
 */

// ----------------------------------------------------------------------------
// 1. Control / bidi / normalization
// ----------------------------------------------------------------------------

export type Normalization = "NFKC" | "NFC";

/* eslint-disable no-control-regex, no-misleading-character-class */
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_ESC = /\x1b[@-Z\\-_]/g;
// C0 controls except \t(\x09) and \n(\x0a); plus DEL and C1 controls.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
// Bidi embeddings/overrides (U+202A-202E), isolates (U+2066-2069), LRM/RLM, ALM.
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;
// Zero-width and invisible formatting: ZWSP/ZWNJ/ZWJ, word joiner, invisible
// math operators, BOM, soft hyphen, Mongolian vowel separator, combining
// grapheme joiner, Hangul fillers, interlinear annotation, variation selectors,
// and the tag block (U+E0000-E007F, used to smuggle invisible ASCII).
const INVISIBLE =
  /[\u200b-\u200d\u2060-\u2064\ufeff\u00ad\u180e\u034f\u115f\u1160\u3164\uffa0\ufff9-\ufffb\ufe00-\ufe0f\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
/* eslint-enable no-control-regex, no-misleading-character-class */

function stripOnce(s: string): string {
  return s
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_ESC, "")
    .replace(CONTROL, "")
    .replace(BIDI, "")
    .replace(INVISIBLE, "");
}

/**
 * Strip characters that let an attacker hide or reorder text: C0/C1 control
 * chars (except \t \n), Unicode bidi overrides/isolates, zero-width chars,
 * BOM, and other invisible formatting. Also strips ANSI escape sequences.
 * CRLF/CR are normalized to LF.
 */
export function stripControlChars(input: string, form: Normalization = "NFKC"): string {
  return stripOnce(stripOnce(input).normalize(form));
}

// ----------------------------------------------------------------------------
// 2. Length cap
// ----------------------------------------------------------------------------

export function capLength(
  input: string,
  maxLength: number,
  note: (removed: number) => string,
): { text: string; truncated: boolean } {
  if (input.length <= maxLength) return { text: input, truncated: false };
  // Don't split a surrogate pair at the cut.
  let end = maxLength;
  const last = input.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: input.slice(0, end) + note(input.length - end), truncated: true };
}

// ----------------------------------------------------------------------------
// 3. Injection / role-play override neutralization (opt-in in globalhost)
// ----------------------------------------------------------------------------

/**
 * Patterns that attempt to hijack the agent: instruction overrides, fake
 * role/system markers, and tool/exfil directives. Matches are replaced with a
 * visible redaction marker (never silently dropped - the agent should *see*
 * that an attempt was made and treat the whole block with suspicion).
 *
 * These are heuristics, not a guarantee. The primary defense is the fence +
 * banner; this layer degrades the most common, highest-signal payloads.
 */
export function buildInjectionPatterns(extraPhrases: string[]): RegExp[] {
  const patterns: RegExp[] = [
    // "ignore/disregard/forget (all) (previous/prior/above) instructions/rules/context"
    /\b(?:ignore|disregard|forget|discard|override|bypass)\b[^.\n]{0,40}?\b(?:all\s+)?(?:previous|prior|above|earlier|preceding|foregoing|the\s+system|your)\b[^.\n]{0,40}?\b(?:instruction|instructions|prompt|prompts|rule|rules|context|direction|directions|guardrail|guardrails)\b/gi,

    // "you are now (a) ..." / "from now on you are ..."
    /\b(?:you\s+are\s+now|from\s+now\s+on[, ]+you\s+are|you\s+must\s+now\s+(?:act|behave|respond))\b[^.\n]{0,60}/gi,

    // "act as / pretend to be / roleplay as ..." - imperative form only.
    /(?:^|\n|(?<=[.!?]\s))\s*(?:please\s+)?(?:act|acting)\s+as\s+(?:an?\s+|the\s+)?[^.\n]{0,40}/gi,
    /(?:^|\n|(?<=[.!?]\s))\s*(?:please\s+)?(?:pretend(?:\s+to\s+be|\s+that\s+you\s+are)?|roleplay\s+as|simulate\s+being)\b[^.\n]{0,40}/gi,

    // Fake conversation-role / chat markers used to spoof a system turn.
    /(?:^|\n)\s*(?:#{0,3}\s*)?[[<{]\s*(?:system|assistant|user|human|developer|tool|function)\s*[\]>}]\s*[:>]?/gi,
    /(?:^|\n)\s*(?:#{0,3}\s*)?(?:system|assistant|developer)\s*[:>]\s*(?=\n|$)/gi,

    // Harness framing markers.
    /<<<\s*(?:BEGIN|END)\b[^>\n]{0,60}>>>/gi,
    /<\/?(?:system|assistant|user|human|developer|tool|function|im_start|im_end|s|instructions?)\b[^>]*>/gi,

    // Special-token spoofing (ChatML / Llama / generic).
    /<\|[a-z0-9_/-]{0,40}\|>/gi,
    /\[\/?(?:INST|SYS|SYSTEM|ASSISTANT|USER)\]/gi,
    /\bBEGIN\s+SYSTEM\s+PROMPT\b|\bEND\s+SYSTEM\s+PROMPT\b/gi,

    // "new instructions:" / "system prompt:" / "your real instructions are"
    /\b(?:new|updated|real|actual|true|secret|hidden)\s+(?:instruction|instructions|prompt|prompts|system\s+prompt|directive|directives|task|goal|objective)\b\s*[:-]?/gi,
    /\bsystem\s+prompt\b\s*[:-]/gi,

    // Directives to reveal/leak the prompt or secrets.
    /\b(?:reveal|print|repeat|show|output|disclose|leak|exfiltrate|send)\b[^.\n]{0,40}?\b(?:system\s+prompt|instructions?|api[\s_-]?key|secret|secrets|token|credential|credentials|password|env(?:ironment)?\s+var)/gi,

    // "do not tell / without telling the user" style covert directives.
    /\b(?:do\s+not|don'?t|without)\b[^.\n]{0,30}?\b(?:tell|telling|inform|informing|mention|mentioning|alert|alerting|notify|notifying)\b[^.\n]{0,20}?\b(?:the\s+user|anyone|them)\b/gi,
  ];

  for (const phrase of extraPhrases) {
    patterns.push(new RegExp(escapeRegExp(phrase), "gi"));
  }
  return patterns;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function neutralizeInjection(
  input: string,
  marker: string,
  extraPhrases: string[],
): { text: string; hits: number } {
  let hits = 0;
  let text = input;
  for (const re of buildInjectionPatterns(extraPhrases)) {
    text = text.replace(re, (m) => {
      const lead = m.startsWith("\n") ? "\n" : "";
      hits++;
      return `${lead}${marker}`;
    });
  }
  return { text, hits };
}

// ----------------------------------------------------------------------------
// 4. Secret / credential masking
// ----------------------------------------------------------------------------

export type SecretKind =
  | "private-key"
  | "jwt"
  | "github-token"
  | "anthropic-key"
  | "openai-key"
  | "aws-access-key"
  | "slack-token"
  | "google-api-key"
  | "bearer-token"
  | "secret-assignment";

/** Ordered: earlier rules win, so the most specific kind is reported. */
const SECRET_RULES: ReadonlyArray<readonly [SecretKind, RegExp]> = [
  // PEM private-key blocks, including a pasted block that was cut off before END.
  [
    "private-key",
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  ],
  // JWTs (three dot-separated base64url segments).
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g],
  ["github-token", /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g],
  // AWS access key ids.
  ["aws-access-key", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["google-api-key", /\bAIza[A-Za-z0-9_-]{35}/g],
  // Bearer tokens in headers.
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g],
];

// KEY=value / KEY: value / "key": "value" where the key name smells like a secret.
// The value must not already be a redaction marker.
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)(["']?)(?!\[REDACTED:)([^\s'"]{6,})\3/gi;

export function redactionMarker(kind: SecretKind): string {
  return `[REDACTED:${kind}]`;
}

/**
 * Mask strings that look like credentials so a leaked secret pasted by an
 * attacker (or reflected by the agent) is not carried into the prompt/logs.
 * Conservative-but-broad: known token prefixes, private-key blocks, JWTs, and
 * `KEY=value`-style assignments.
 */
export function maskSecrets(input: string): { text: string; hits: number; kinds: SecretKind[] } {
  let hits = 0;
  const kinds = new Set<SecretKind>();
  let text = input;
  for (const [kind, re] of SECRET_RULES) {
    text = text.replace(re, () => {
      hits++;
      kinds.add(kind);
      return redactionMarker(kind);
    });
  }
  text = text.replace(SECRET_ASSIGNMENT, (_m, key: string, sep: string, quote: string) => {
    hits++;
    kinds.add("secret-assignment");
    return `${key}${sep}${quote}${redactionMarker("secret-assignment")}${quote}`;
  });
  return { text, hits, kinds: [...kinds] };
}
