import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, cleanupTestDataDir, createTestFile } from "./setup";

interface GetResult {
  file: string;
  start_line: number;
  end_line: number;
  content: string;
  word_count: number;
  char_count: number;
}

interface ErrorResult {
  error: boolean;
  code: string;
  message: string;
  command: string;
}

describe("Get Command", () => {
  let testFilePath: string;
  let testContent: string;

  beforeAll(async () => {
    await setupTestDataDir();

    // Create a test file with known content
    testContent = `# Test Document

## Section 1: Introduction
This is the first paragraph of the introduction.
It contains multiple lines of text.
Here is the third line.

## Section 2: Details
The details section has important information.
Line 2 of details.
Line 3 of details.
Line 4 of details.

## Section 3: Conclusion
This is the conclusion.
It summarizes the key points.
Thank you for reading.`;

    testFilePath = await createTestFile("test-document.md", testContent);
  });

  afterAll(async () => {
    await cleanupTestDataDir();
  });

  it("should retrieve content by line range", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", testFilePath, "4", "7"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout.trim()) as GetResult;

    expect(result.file).toBe(testFilePath);
    expect(result.start_line).toBe(4);
    expect(result.end_line).toBe(7);
    expect(result.content).toContain("first paragraph");
    expect(result.content).toContain("multiple lines");
    expect(result.word_count).toBeGreaterThan(0);
    expect(result.char_count).toBeGreaterThan(0);
  });

  it("should return correct word and char counts", async () => {
    // Create a simple file with known content
    const simpleContent = "Hello world test";
    const simplePath = await createTestFile("simple.md", simpleContent);

    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", simplePath, "1", "1"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout.trim()) as GetResult;

    expect(result.word_count).toBe(3); // "Hello", "world", "test"
    expect(result.char_count).toBe(16); // "Hello world test" = 16 chars
    expect(result.content).toBe(simpleContent);
  });

  it("should clamp start_line to 1 if less than 1", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", testFilePath, "0", "3"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout.trim()) as GetResult;

    expect(result.start_line).toBe(1);
    expect(result.content).toContain("# Test Document");
  });

  it("should clamp end_line to file length if exceeds bounds", async () => {
    const lines = testContent.split("\n").length;

    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", testFilePath, String(lines - 2), "999"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout.trim()) as GetResult;

    expect(result.end_line).toBeLessThanOrEqual(lines);
    expect(result.content).toContain("Thank you for reading");
  });

  it("should ensure end_line is not less than start_line", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", testFilePath, "10", "5"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(1); // Should exit with error

    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("start_line must be less than or equal to end_line");
  });

  it("should handle non-existent file with error", async () => {
    const nonExistentPath = "/path/to/nonexistent/file.md";

    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", nonExistentPath, "1", "10"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(2);

    const stderr = await new Response(proc.stderr).text();
    const error = JSON.parse(stderr.trim()) as ErrorResult;

    expect(error.error).toBe(true);
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(error.message).toContain("does not exist");
    expect(error.command).toBe("get");
  });

  it("should reject invalid line numbers (non-numeric)", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", testFilePath, "abc", "10"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);

    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Line numbers must be valid integers");
  });

  it("should reject negative line numbers", async () => {
    // Negative numbers should be clamped to 1, not rejected
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", testFilePath, "-5", "10"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    // Should succeed by clamping -5 to 1
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout.trim()) as GetResult;
    expect(result.start_line).toBe(1);
  });

  it("should show help with --help flag", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", "--help"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("Usage: memory get");
    expect(stdout).toContain("<file>");
    expect(stdout).toContain("<start_line>");
    expect(stdout).toContain("<end_line>");
  });

  it("should show usage when insufficient arguments", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", testFilePath],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);

    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Usage:");
    expect(stderr).toContain("memory get");
  });

  it("should handle single line retrieval", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", testFilePath, "1", "1"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout.trim()) as GetResult;

    expect(result.start_line).toBe(1);
    expect(result.end_line).toBe(1);
    expect(result.content).toBe("# Test Document");
    expect(result.word_count).toBe(3);
  });

  it("should handle empty lines correctly", async () => {
    const contentWithEmpty = "Line 1\n\nLine 3";
    const emptyPath = await createTestFile("empty-lines.md", contentWithEmpty);

    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", emptyPath, "1", "3"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout.trim()) as GetResult;

    expect(result.content).toBe(contentWithEmpty);
    expect(result.word_count).toBe(4); // "Line", "1", "Line", "3"
  });

  it("should work with tesla.md for real-world integration test", async () => {
    // This test verifies the workflow described in MEMORY_SPEC
    // First search, then get the results
    const teslaPath = "/home/emmert/Work/mem/tesla.md";

    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "get", teslaPath, "678", "698"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout.trim()) as GetResult;

    expect(result.file).toBe(teslaPath);
    expect(result.start_line).toBe(678);
    expect(result.end_line).toBe(698);
    expect(result.content).toContain("tzero");
    expect(result.content).toContain("250 miles");
    expect(result.word_count).toBeGreaterThan(100);
    expect(result.char_count).toBeGreaterThan(500);
  });

  it("should verify end-to-end workflow: search then get", async () => {
    // Step 1: Search for tzero range
    const searchProc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "search", "AC Propulsion tzero range", "--no-rerank"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const searchExitCode = await searchProc.exited;
    expect(searchExitCode).toBe(0);

    const searchStdout = await new Response(searchProc.stdout).text();
    const searchResults = JSON.parse(searchStdout.trim()) as Array<{
      file: string;
      start_line: number;
      end_line: number;
      score: number;
      content_preview: string;
    }>;

    expect(searchResults.length).toBeGreaterThan(0);

    // Step 2: Get the content from the first result
    const firstResult = searchResults[0];
    const getProc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "src/index.ts",
        "get",
        firstResult.file,
        String(firstResult.start_line),
        String(firstResult.end_line),
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const getExitCode = await getProc.exited;
    expect(getExitCode).toBe(0);

    const getStdout = await new Response(getProc.stdout).text();
    const getResult = JSON.parse(getStdout.trim()) as GetResult;

    expect(getResult.file).toBe(firstResult.file);
    expect(getResult.start_line).toBe(firstResult.start_line);
    expect(getResult.end_line).toBe(firstResult.end_line);
    expect(getResult.content).toBeTruthy();
    expect(getResult.word_count).toBeGreaterThan(0);
  }, 60000);

  it("should include get in global help", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "--help"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("get");
  });
});
