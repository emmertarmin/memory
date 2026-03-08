import { describe, it, expect } from "bun:test";
import { chunkText, createPreview } from "../src/chunker";

describe("chunkText", () => {
  it("should split text into chunks around target token size", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    const chunks = chunkText(text, { targetTokens: 10, overlapTokens: 2, lineBoundary: true });

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].content).toContain("Line 1");
    expect(chunks[0].startLine).toBe(1);
  });

  it("should respect line boundaries and not split mid-line", () => {
    const text = "First line here\nSecond line here\nThird line here";
    const chunks = chunkText(text, { targetTokens: 50, overlapTokens: 5, lineBoundary: true });

    for (const chunk of chunks) {
      // Each chunk should only contain complete lines
      const lines = chunk.content.split("\n");
      for (const line of lines) {
        // No line should be empty (unless it's intentional newline)
        // This is a loose check - mainly we ensure no "half lines"
        expect(line).toBeTruthy();
      }
    }
  });

  it("should create overlapping chunks", () => {
    const longText = Array(50).fill("This is a line with some content.").join("\n");
    const chunks = chunkText(longText, {
      targetTokens: 100,
      overlapTokens: 20,
      lineBoundary: true,
    });

    if (chunks.length > 1) {
      // Second chunk should start before first chunk ends (overlap)
      expect(chunks[1].startLine).toBeLessThan(chunks[0].endLine);
    }
  });

  it("should handle short text as single chunk", () => {
    const text = "Short text.";
    const chunks = chunkText(text);

    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  it("should track line numbers correctly", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8";
    const chunks = chunkText(text, { targetTokens: 20, overlapTokens: 5, lineBoundary: true });

    expect(chunks[0].startLine).toBe(1);
    // First chunk should span some lines
    expect(chunks[0].endLine).toBeGreaterThan(1);
  });

  it("should return accurate token estimates (approx 4 chars per token)", () => {
    const text = "12345678901234567890"; // 20 chars ≈ 5 tokens
    const chunks = chunkText(text);

    expect(chunks[0].tokenCount).toBeGreaterThanOrEqual(4);
    expect(chunks[0].tokenCount).toBeLessThanOrEqual(6);
  });
});

describe("createPreview", () => {
  it("should return full content if under max length", () => {
    const content = "Short content";
    const preview = createPreview(content, 100);
    expect(preview).toBe(content);
  });

  it("should truncate content and add ellipsis if over max length", () => {
    const content = "A".repeat(300);
    const preview = createPreview(content, 200);
    expect(preview).toBe("A".repeat(200) + "...");
  });

  it("should default to 200 char limit", () => {
    const content = "A".repeat(250);
    const preview = createPreview(content);
    expect(preview.endsWith("...")).toBe(true);
    expect(preview.length).toBe(203); // 200 + "..."
  });
});
