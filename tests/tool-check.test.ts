/**
 * Tests for tool availability checks.
 */

import { checkTool, checkAllTools, assertRequiredTools, REQUIRED_TOOLS } from "../src/tool-check";

describe("checkTool", () => {
  it("finds node as available", () => {
    const nodeTool = REQUIRED_TOOLS.find((t) => t.name === "node")!;
    const result = checkTool(nodeTool);
    expect(result.available).toBe(true);
    expect(result.version).toContain("v");
  });

  it("finds 7z as available", () => {
    const sevenZip = REQUIRED_TOOLS.find((t) => t.name === "7z")!;
    const result = checkTool(sevenZip);
    expect(result.available).toBe(true);
  });

  it("reports unavailable tool", () => {
    const fakeTool = {
      name: "nonexistent_tool_xyz_12345",
      description: "Test tool that does not exist",
      required: false,
    };
    const result = checkTool(fakeTool);
    expect(result.available).toBe(false);
  });
});

describe("checkAllTools", () => {
  it("returns results for all defined tools", () => {
    const { results } = checkAllTools();
    expect(results.length).toBe(REQUIRED_TOOLS.length);
  });

  it("required tools (node, npm, 7z) are available", () => {
    const { results } = checkAllTools();
    const requiredResults = results.filter((r) => {
      const tool = REQUIRED_TOOLS.find((t) => t.name === r.tool);
      return tool?.required;
    });

    for (const result of requiredResults) {
      expect(result.available).toBe(true);
    }
  });

  it("rpmbuild is not available on this host", () => {
    const { results } = checkAllTools();
    const rpm = results.find((r) => r.tool === "rpmbuild");
    expect(rpm?.available).toBe(false);
  });
});

describe("assertRequiredTools", () => {
  it("does not throw when required tools are available", () => {
    expect(() => assertRequiredTools()).not.toThrow();
  });
});
