/**
 * @module markdown-sanitizer
 *
 * Markdown-aware input sanitiser for contributor notes and tags.
 *
 * ## Why a custom sanitiser?
 *
 * The project has no DOM available on the server and deliberately avoids
 * shipping a heavy HTML-parser dependency (DOMPurify requires jsdom; the
 * `sanitize-html` package is 1 MB+).  Contributor notes are a constrained
 * domain: the input field is a plain `<textarea>` rendered by maintainers
 * only; output is displayed in a React component that escapes by default.
 *
 * We need two guarantees:
 *   1. **No stored XSS** — raw HTML / script tags / javascript: / data: URIs
 *      must never reach the database.
 *   2. **Markdown formatting is preserved** — bold, italic, inline code,
 *      blockquotes, and https:// links are legitimate and should survive.
 *
 * This module provides a two-mode sanitiser:
 *   - `sanitizeMarkdown(input)` — strips dangerous HTML while preserving safe
 *     markdown syntax.
 *   - `sanitizeMarkdown(input, { plainTextOnly: true })` — strips all markup
 *     including markdown syntax, for tags and other plain-text fields.
 *
 * ## Threat model
 *
 * | Threat | Mitigation |
 * |--------|-----------|
 * | `<script>` tags | Stripped entirely |
 * | Inline event handlers (`onclick=`, `onerror=`) | Stripped with containing tag |
 * | `javascript:` / `data:` URIs in links | Replaced with `#` |
 * | HTML entities used to obfuscate attacks | Decoded then re-checked |
 * | Markdown link injection `[text](javascript:...)` | URI scheme validated — non-https:// blocked |
 * | Oversized payloads | Enforced by the Zod schema (1 000 char limit after sanitisation) |
 *
 * ## What is preserved
 *
 * Standard CommonMark inline syntax that does not involve HTML:
 *   `**bold**`, `*italic*`, `_italic_`, `` `code` ``, `> blockquote`,
 *   `[text](https://example.com)`, `# Heading`, `- list item`, `1. list item`.
 *
 * ## Limitations
 *
 * This is a denylist-based sanitiser, which is inherently less robust than a
 * full HTML parser + allowlist (e.g. `rehype-sanitize`).  It is appropriate
 * here because:
 *   a) React escapes HTML on render by default, so even if an edge-case slips
 *      through, it is not directly executable in the browser.
 *   b) Notes are written and read only by authenticated maintainers; the
 *      attack surface is not public.
 *   c) If the project ever adds a markdown renderer with `dangerouslySetInnerHTML`,
 *      the sanitiser must be upgraded to a full parser + allowlist.
 */

export interface SanitizeOptions {
  /**
   * When `true`, strip all markup (HTML and markdown syntax) and return only
   * plain text.  Use for tags and other non-formatted fields.
   */
  plainTextOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * HTML-decode a small set of named and numeric entities so the denylist
 * catches obfuscated payloads like `&#106;avascript:` or `&lt;script&gt;`.
 *
 * We don't decode every HTML entity — only the ones relevant to XSS.
 */
function decodeXssEntities(input: string): string {
  return input
    // Decimal numeric entities: &#106; → j
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 10))
    )
    // Hex numeric entities: &#x6A; → j
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16))
    )
    // Named entities most relevant to XSS
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'");
}

/**
 * Check whether a URI is safe to appear in rendered output.
 * Only `https://`, relative paths (`/`, `./`, `../`), and anchor refs (`#`)
 * are allowed.  Everything else (javascript:, data:, vbscript:, etc.) is
 * replaced with a safe placeholder.
 */
function sanitizeUri(uri: string): string {
  const trimmed = uri.trim();
  // Allow safe schemes and relative refs
  if (
    /^https:\/\//i.test(trimmed) ||
    /^\/[^/]/i.test(trimmed) ||
    /^\.\.\//i.test(trimmed) ||
    /^\.\//i.test(trimmed) ||
    trimmed.startsWith("#")
  ) {
    return trimmed;
  }
  // Block everything else
  return "#";
}

/**
 * Strip all raw HTML from the input.
 *
 * Handles:
 *   - Normal open/close/self-closing tags: `<script>`, `</b>`, `<br />`
 *   - HTML comments: `<!-- ... -->`
 *   - Script and style blocks (content + tag stripped entirely)
 *   - Event-handler attributes (stripped as part of their containing tag)
 *
 * This does NOT unescape HTML entities first — call `decodeXssEntities` on
 * the input before this function when obfuscation is a concern.
 */
function stripHtmlTags(input: string): string {
  return (
    input
      // Remove entire <script>…</script> blocks (content is dangerous)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      // Remove entire <style>…</style> blocks
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      // Remove HTML comments
      .replace(/<!--[\s\S]*?-->/g, "")
      // Remove all remaining HTML tags (open, close, self-closing)
      .replace(/<[^>]*>?/gm, "")
      .trim()
  );
}

/**
 * Sanitise markdown-style links `[text](url)` so that the URL is safe.
 *
 * The text part is left unchanged (it will be HTML-escaped on render).
 * The URI is run through `sanitizeUri` so `javascript:` links become `#`.
 *
 * Strategy: capture everything between the outer `(` and the last matching `)`.
 * We use a lazy match `[^)]*` which stops at the first `)`, then re-assemble
 * the full URI including any nested `(...)` groups by repeated expansion.
 * For the common attack vector `[x](javascript:alert(1))`, the outer `)` is
 * the link terminator and the inner `alert(1)` is already blocked by the
 * URI scheme check — we just need to make sure we don't leave a stray `)`.
 */
function sanitizeMarkdownLinks(input: string): string {
  // This regex handles the two cases we care about:
  //   [text](safe-uri)              — no nested parens
  //   [text](uri-with-(parens))     — one level of nested parens (Wikipedia etc.)
  //
  // The replacement blocks any URI that isn't https://, relative, or anchor.
  // For `[x](javascript:alert(1))` the outer form is fine — `javascript:alert(1`
  // is the URI (captured by [^)]*), the inner `)` closes the URI, and the last
  // `)` is not captured. We then re-append the trailing `)` to the output via
  // a look-ahead-free approach: match the full outer form with a greedy last-`)`.
  return input.replace(
    /\[([^\]]*)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
    (_, text: string, uri: string) => {
      const safeUri = sanitizeUri(uri);
      return `[${text}](${safeUri})`;
    }
  );
}

/**
 * Strip markdown syntax to produce plain text.
 *
 * Handles the CommonMark inline constructs most commonly used in notes:
 *   `**bold**` → `bold`
 *   `*italic*` / `_italic_` → `italic`
 *   `` `code` `` → `code`
 *   `[text](url)` → `text`
 *   `> blockquote` → `blockquote`
 *   `# Heading` → `Heading`
 *   `- item` / `* item` / `1. item` → `item`
 *   Horizontal rules (`---`, `***`, `___`) → removed
 */
function stripMarkdownSyntax(input: string): string {
  return (
    input
      // ATX headings: # text → text
      .replace(/^#{1,6}\s+/gm, "")
      // Bold+italic: ***text*** or ___text___
      .replace(/\*{3}([^*]+)\*{3}/g, "$1")
      .replace(/_{3}([^_]+)_{3}/g, "$1")
      // Bold: **text** or __text__
      .replace(/\*{2}([^*]+)\*{2}/g, "$1")
      .replace(/_{2}([^_]+)_{2}/g, "$1")
      // Italic: *text* or _text_
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      // Inline code: `code`
      .replace(/`([^`]+)`/g, "$1")
      // Fenced code blocks: ```\ncode\n``` or ~~~\ncode\n~~~
      .replace(/```[\s\S]*?```/g, "")
      .replace(/~~~[\s\S]*?~~~/g, "")
      // Markdown links: [text](url) → text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Blockquotes: > text → text
      .replace(/^>\s*/gm, "")
      // Unordered lists: - item or * item
      .replace(/^[\-\*\+]\s+/gm, "")
      // Ordered lists: 1. item
      .replace(/^\d+\.\s+/gm, "")
      // Horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, "")
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitise a contributor note or tag value.
 *
 * In default mode, the result preserves safe markdown syntax and strips raw
 * HTML and dangerous URIs.  When `plainTextOnly` is `true`, all markup is
 * removed and only plain text remains.
 *
 * @param input     Raw user input.
 * @param options   Sanitisation options.
 * @returns         Sanitised string, trimmed.
 */
export function sanitizeMarkdown(
  input: string,
  options: SanitizeOptions = {}
): string {
  if (typeof input !== "string") return "";

  // Step 1: Decode HTML entities that could obfuscate dangerous patterns.
  //         We do this on a copy so the denylist check sees the decoded form.
  const decoded = decodeXssEntities(input);

  // Step 2: Strip raw HTML (script/style blocks, tags, comments).
  const noHtml = stripHtmlTags(decoded);

  if (options.plainTextOnly) {
    // Step 3a: For plain-text fields, also strip markdown syntax.
    return stripMarkdownSyntax(noHtml);
  }

  // Step 3b: For markdown fields, sanitise inline link URIs.
  const safeLinks = sanitizeMarkdownLinks(noHtml);

  return safeLinks.trim();
}
