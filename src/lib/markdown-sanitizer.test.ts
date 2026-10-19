import { describe, expect, it } from "vitest";
import { sanitizeMarkdown } from "./markdown-sanitizer";

// ── Default mode (markdown preserved, HTML stripped) ─────────────────────────

describe("sanitizeMarkdown — default mode (markdown preserved)", () => {
  it("passes through plain text unchanged", () => {
    expect(sanitizeMarkdown("Hello world")).toBe("Hello world");
  });

  it("passes through safe markdown bold syntax", () => {
    expect(sanitizeMarkdown("**important**")).toBe("**important**");
  });

  it("passes through safe markdown italic syntax", () => {
    expect(sanitizeMarkdown("*note*")).toBe("*note*");
  });

  it("passes through inline code", () => {
    expect(sanitizeMarkdown("`code here`")).toBe("`code here`");
  });

  it("passes through a blockquote", () => {
    expect(sanitizeMarkdown("> quoted text")).toBe("> quoted text");
  });

  it("passes through a heading", () => {
    expect(sanitizeMarkdown("# Heading")).toBe("# Heading");
  });

  it("passes through a safe https:// markdown link", () => {
    expect(sanitizeMarkdown("[TrustBridge](https://example.com)")).toBe(
      "[TrustBridge](https://example.com)"
    );
  });

  it("replaces javascript: URI in a markdown link with #", () => {
    expect(sanitizeMarkdown("[click](javascript:alert(1))")).toBe(
      "[click](#)"
    );
  });

  it("replaces data: URI in a markdown link with #", () => {
    expect(sanitizeMarkdown("[img](data:text/html,<script>alert(1)</script>)")).toContain(
      "(#)"
    );
  });

  it("strips <script> tags entirely", () => {
    const result = sanitizeMarkdown("<script>alert('xss')</script>Hello");
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("alert('xss')");
    expect(result).toBe("Hello");
  });

  it("strips <script> block with content", () => {
    const result = sanitizeMarkdown(
      "**bold** <script>document.cookie='x=1'</script> text"
    );
    expect(result).not.toContain("document.cookie");
    expect(result).toBe("**bold**  text");
  });

  it("strips <style> blocks", () => {
    const result = sanitizeMarkdown("<style>body{display:none}</style>text");
    expect(result).not.toContain("<style>");
    expect(result).not.toContain("display:none");
    expect(result).toBe("text");
  });

  it("strips HTML comments", () => {
    expect(sanitizeMarkdown("<!-- hidden -->visible")).toBe("visible");
  });

  it("strips arbitrary HTML tags while keeping text content", () => {
    expect(sanitizeMarkdown("<b>bold text</b>")).toBe("bold text");
  });

  it("strips event-handler attributes via tag removal", () => {
    const result = sanitizeMarkdown('<img src="x" onerror="alert(1)">text');
    expect(result).not.toContain("onerror");
    expect(result).toBe("text");
  });

  it("strips HTML tags but preserves surrounding markdown", () => {
    const result = sanitizeMarkdown(
      "**Safe** <em>not safe html</em> _also safe_"
    );
    expect(result).toBe("**Safe** not safe html _also safe_");
  });

  it("decodes HTML entities before checking — catches &#106;avascript:", () => {
    // &#106; is 'j' → the decoded form becomes "javascript:"
    const result = sanitizeMarkdown("[x](&#106;avascript:alert(1))");
    expect(result).not.toContain("javascript:");
    // The link URI should be replaced with #
    expect(result).toBe("[x](#)");
  });

  it("decodes hex entities before checking — catches &#x6A;avascript:", () => {
    const result = sanitizeMarkdown("[x](&#x6A;avascript:alert(1))");
    expect(result).not.toContain("javascript:");
    expect(result).toBe("[x](#)");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeMarkdown("  hello  ")).toBe("hello");
  });

  it("preserves newlines within the text body", () => {
    const input = "line one\nline two";
    expect(sanitizeMarkdown(input)).toBe(input);
  });
});

// ── Plain-text mode (markdown syntax stripped too) ───────────────────────────

describe("sanitizeMarkdown — plainTextOnly mode (tags removed)", () => {
  it("strips bold markdown", () => {
    expect(sanitizeMarkdown("**important**", { plainTextOnly: true })).toBe(
      "important"
    );
  });

  it("strips italic markdown", () => {
    expect(sanitizeMarkdown("*note*", { plainTextOnly: true })).toBe("note");
  });

  it("strips inline code", () => {
    expect(sanitizeMarkdown("`code`", { plainTextOnly: true })).toBe("code");
  });

  it("strips heading markers", () => {
    expect(sanitizeMarkdown("# Tag Name", { plainTextOnly: true })).toBe(
      "Tag Name"
    );
  });

  it("strips markdown links and keeps only the link text", () => {
    expect(
      sanitizeMarkdown("[TrustBridge](https://example.com)", { plainTextOnly: true })
    ).toBe("TrustBridge");
  });

  it("strips blockquote markers", () => {
    expect(sanitizeMarkdown("> quote", { plainTextOnly: true })).toBe("quote");
  });

  it("strips HTML tags", () => {
    expect(
      sanitizeMarkdown("<b>text</b>", { plainTextOnly: true })
    ).toBe("text");
  });

  it("strips script tags", () => {
    const result = sanitizeMarkdown(
      "<script>alert(1)</script>clean",
      { plainTextOnly: true }
    );
    expect(result).not.toContain("alert");
    expect(result).toBe("clean");
  });

  it("returns only plain text from a mixed input", () => {
    const result = sanitizeMarkdown(
      "**VIP** contributor <script>evil()</script>",
      { plainTextOnly: true }
    );
    expect(result).toBe("VIP contributor");
  });

  it("returns empty string when all content is markup", () => {
    expect(
      sanitizeMarkdown("<script>evil()</script>", { plainTextOnly: true })
    ).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(
      sanitizeMarkdown("  tag  ", { plainTextOnly: true })
    ).toBe("tag");
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("sanitizeMarkdown — edge cases", () => {
  it("handles an empty string", () => {
    expect(sanitizeMarkdown("")).toBe("");
  });

  it("handles a string that is only whitespace", () => {
    expect(sanitizeMarkdown("   ")).toBe("");
  });

  it("handles a deeply nested HTML tag structure", () => {
    const result = sanitizeMarkdown(
      "<div><p><span onclick='evil()'>text</span></p></div>"
    );
    expect(result).not.toContain("<");
    expect(result).not.toContain("onclick");
    expect(result).toBe("text");
  });

  it("handles multiple script tags in sequence", () => {
    const result = sanitizeMarkdown(
      "<script>a()</script>ok<script>b()</script>"
    );
    expect(result).toBe("ok");
  });

  it("is not type-coercing — empty string when called with non-string", () => {
    // TypeScript guards the type but the runtime check is defensive
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(sanitizeMarkdown(null as any)).toBe("");
  });
});
