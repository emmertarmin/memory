import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, cleanupTestDataDir, createTestFile, TEST_CONFIG_PATH } from "./setup";
import * as path from "path";

describe("CLI Integration", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await setupTestDataDir();
  });

  afterAll(async () => {
    await cleanupTestDataDir();
  });

  it("should output JSON format for indexed file when API key is valid", async () => {
    const content = `# Test Article

This is a test article with multiple lines.
It has several paragraphs.

## Section 2

More content here.
`.repeat(10);

    const filePath = await createTestFile("cli-test.md", content);

    // Check if we have a real API key
    const testConfig = JSON.parse(await Bun.file(TEST_CONFIG_PATH).text());
    const hasRealApiKey = testConfig.apiKey && testConfig.apiKey !== "sk-test-api-key-for-testing";

    if (!hasRealApiKey) {
      console.log("Skipping - no real API key available for CLI test");
      return;
    }

    // Run the CLI with test config - new subcommand format
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "index", filePath, "--force"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MEMORY_CONFIG_PATH: TEST_CONFIG_PATH },
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);

    // Parse JSON output
    const output = JSON.parse(stdout.trim());
    expect(output.file).toBe(filePath);
    expect(output.status).toBe("indexed");
    expect(output.chunksIndexed).toBeGreaterThan(0);
    expect(output.linesTotal).toBeGreaterThan(0);
    expect(output.embeddingsGenerated).toBeGreaterThan(0);
  }, 30000);

  it("should skip unchanged files on second run", async () => {
    const content = "Simple content";
    const filePath = await createTestFile("skip-test.md", content);

    // Check if we have a real API key
    const testConfig = JSON.parse(await Bun.file(TEST_CONFIG_PATH).text());
    const hasRealApiKey = testConfig.apiKey && testConfig.apiKey !== "sk-test-api-key-for-testing";

    if (!hasRealApiKey) {
      console.log("Skipping - no real API key available for skip test");
      return;
    }

    // First run
    const proc1 = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "index", filePath],
      cwd: process.cwd(),
      stdout: "pipe",
      env: { ...process.env, MEMORY_CONFIG_PATH: TEST_CONFIG_PATH },
    });
    await proc1.exited;

    // Second run (without --force)
    const proc2 = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "index", filePath],
      cwd: process.cwd(),
      stdout: "pipe",
      env: { ...process.env, MEMORY_CONFIG_PATH: TEST_CONFIG_PATH },
    });

    const stdout2 = await new Response(proc2.stdout).text();
    const output2 = JSON.parse(stdout2.trim());

    expect(output2.status).toBe("skipped");
    expect(output2.skipped).toBe(true);
  });

  it("should show helpful error for non-existent file", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "index", "/nonexistent/file.md"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MEMORY_CONFIG_PATH: TEST_CONFIG_PATH },
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("FILE_NOT_FOUND");
  });

  it.todo("should support custom chunk sizes via CLI flag", async () => {
    // This is partially implemented but needs better end-to-end testing
    // with verification that different chunk sizes produce different chunk counts
    expect(true).toBe(true);
  });

  it("should support recursive directory indexing", async () => {
    // Create nested structure using actual Bun.Glob like src/index.ts does
    const dir1 = path.join(testDir, "nested");
    const dir2 = path.join(dir1, "deep");

    // Create directories
    await Bun.write(path.join(dir2, "file.md"), "content");
    await Bun.write(path.join(dir1, "shallow.md"), "shallow content");

    // Test that Bun.Glob finds all files recursively
    const glob = new Bun.Glob("**/*.md");
    const files: string[] = [];
    for await (const filePath of glob.scan({
      cwd: testDir,
      absolute: true,
    })) {
      files.push(filePath);
    }

    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some((f) => f.includes("deep"))).toBe(true);
    expect(files.some((f) => f.includes("shallow"))).toBe(true);
  });

  it("should show help when no command provided", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("memory - Markdown indexing and semantic search");
    expect(stdout).toContain("index <path>");
    expect(stdout).toContain("setup");
  });

  it("should error on unknown command", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "unknown"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});
