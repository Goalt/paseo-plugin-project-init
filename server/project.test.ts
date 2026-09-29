import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { COORDINATOR_PROVIDER } from "../shared/project";
import { createProject, missingProviderWarning, renderCoordinatorBody } from "./project";

describe("renderCoordinatorBody", () => {
  it("replaces every {{agents}} and {{name}}", () => {
    const body = "{{name}}: {{agents}}\n{{name}} again\n{{agents}}";
    expect(renderCoordinatorBody(body, "demo", "- a")).toBe("demo: - a\ndemo again\n- a");
  });

  it("appends the subagents section without the placeholder", () => {
    expect(renderCoordinatorBody("Hello {{name}}\n\n", "demo", "- a")).toBe(
      "Hello demo\n\n## Subagents\n- a\n",
    );
  });

  it("keeps a body without placeholders and adds the section", () => {
    expect(renderCoordinatorBody("Plain", "demo", "- a")).toBe("Plain\n\n## Subagents\n- a\n");
  });
});

describe("renderCoordinatorBody edge cases", () => {
  it("inserts $-patterns in the name literally", () => {
    for (const name of ["a$&b", "$1", "$$", "$`x", "$'y"]) {
      expect(renderCoordinatorBody("[{{name}}] {{agents}}", name, "- a")).toBe(`[${name}] - a`);
    }
  });

  it("inserts $-patterns in the subagent list literally", () => {
    expect(renderCoordinatorBody("{{agents}}", "demo", "- $& $1")).toBe("- $& $1");
  });

  it("does not re-expand placeholders from the name", () => {
    expect(renderCoordinatorBody("{{name}} {{agents}}", "{{agents}}", "- a")).toBe("- a - a");
  });
});

describe("missingProviderWarning", () => {
  it("contains a JSON fragment for the provider", () => {
    const warning = missingProviderWarning();
    const fragment = JSON.parse(warning.slice(warning.indexOf("{")));
    expect(fragment.agents.providers[COORDINATOR_PROVIDER].command).toEqual([
      "/usr/local/bin/claude",
      "--agent",
      "coordinator",
    ]);
  });
});

describe("createProject", () => {
  let home: string;
  const input = (overrides: Record<string, unknown> = {}) => ({
    name: " demo ",
    claudeMd: "base",
    coordinator: { tools: ["Read"] },
    agents: [{ id: "developer", tools: null }],
    createSession: true,
    ...overrides,
  });

  const create = vi.fn();

  function context({
    providers = { [COORDINATOR_PROVIDER]: {} } as Record<string, unknown>,
    open = vi.fn().mockResolvedValue({ id: "ws-1", agents: { create } }),
  } = {}) {
    const paseo = {
      config: { get: vi.fn().mockResolvedValue({ requestId: "r", config: { providers } }) },
      workspaces: { open },
    };
    return { create, paseo, context: { paseo } as unknown as PluginHandlerContext };
  }

  beforeEach(async () => {
    create.mockReset().mockResolvedValue({ id: "agent-1" });
    home = await mkdtemp(path.join(tmpdir(), "project-init-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("GIT_AUTHOR_NAME", "Test");
    vi.stubEnv("GIT_AUTHOR_EMAIL", "test@example.com");
    vi.stubEnv("GIT_COMMITTER_NAME", "Test");
    vi.stubEnv("GIT_COMMITTER_EMAIL", "test@example.com");
    const presets = path.join(home, ".paseo-init", "presets");
    await mkdir(path.join(presets, "agents"), { recursive: true });
    await mkdir(path.join(presets, "claude-md"), { recursive: true });
    await writeFile(path.join(presets, "claude-md", "base.md"), "# {{name}}\n");
    await writeFile(
      path.join(presets, "agents", "coordinator.md"),
      "---\ndescription: Coordinates\n---\nProject {{name}}\n{{agents}}\n",
    );
    await writeFile(
      path.join(presets, "agents", "developer.md"),
      "---\ndescription: Develops\ntools: Read, Edit\n---\nWork on {{name}}\n",
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("writes files without an agent key in settings.json", async () => {
    const { context: ctx } = context();
    const result = await createProject(input(), ctx);
    const target = path.join(home, "projects", "demo");
    expect(result.path).toBe(target);
    expect(result.workspaceId).toBe("ws-1");
    expect(result.files.sort()).toEqual([
      ".claude/agents/coordinator.md",
      ".claude/agents/developer.md",
      ".claude/settings.json",
      ".gitignore",
      "CLAUDE.md",
    ]);
    const settings = JSON.parse(await readFile(path.join(target, ".claude/settings.json"), "utf8"));
    expect(settings).not.toHaveProperty("agent");
    for (const file of [".claude/agents/coordinator.md", ".claude/agents/developer.md"]) {
      const content = await readFile(path.join(target, file), "utf8");
      expect(content).not.toContain("{{name}}");
      expect(content).toContain("demo");
    }
    const claudeMd = await readFile(path.join(target, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain(`provider \`${COORDINATOR_PROVIDER}\``);
    expect(claudeMd).not.toContain("(main session)");
    expect(result.warnings).toEqual([]);
  });

  it("removes the directory when opening the workspace fails", async () => {
    const { context: ctx } = context({ open: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(createProject(input(), ctx)).rejects.toThrow("boom");
    expect(await readdir(path.join(home, "projects"))).toEqual([]);
  });

  it("warns with a provider fragment and creates no session when the provider is missing", async () => {
    const { context: ctx } = context({ providers: {} });
    const result = await createProject(input(), ctx);
    expect(result.warnings.some((warning) => warning.includes(`"${COORDINATOR_PROVIDER}"`))).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(await readdir(result.path)).toContain(".claude");
  });

  it("creates a coordinator agent when the provider exists", async () => {
    const { context: ctx } = context();
    const result = await createProject(input(), ctx);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      config: { provider: `${COORDINATOR_PROVIDER}/claude-opus-5-5`, modeId: "auto" },
    });
    expect(typeof create.mock.calls[0][0].prompt).toBe("string");
    expect(result.warnings).toEqual([]);
  });

  it("does not create an agent when the switch is off", async () => {
    const { context: ctx } = context();
    await createProject(input({ createSession: false }), ctx);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the project and warns when agent creation fails", async () => {
    const { context: ctx } = context();
    create.mockRejectedValue(new Error("no model"));
    const result = await createProject(input(), ctx);
    expect(result.warnings.some((warning) => warning.includes("no model"))).toBe(true);
    expect(await readdir(result.path)).toContain(".claude");
  });

  it("warns and skips the session when the provider is disabled", async () => {
    const { context: ctx } = context({ providers: { [COORDINATOR_PROVIDER]: { enabled: false } } });
    const result = await createProject(input(), ctx);
    expect(result.warnings.some((warning) => warning.includes(`"${COORDINATOR_PROVIDER}"`))).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("treats a provider without an enabled field as enabled", async () => {
    const { context: ctx } = context({ providers: { [COORDINATOR_PROVIDER]: { extends: "claude" } } });
    const result = await createProject(input(), ctx);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.warnings).toEqual([]);
  });

  it("warns when the config cannot be read", async () => {
    const { paseo, context: ctx } = context();
    paseo.config.get.mockRejectedValue(new Error("rpc down"));
    const result = await createProject(input(), ctx);
    expect(result.warnings.some((warning) => warning.includes("rpc down"))).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("warns about the missing provider even when the session switch is off", async () => {
    const { context: ctx } = context({ providers: {} });
    const result = await createProject(input({ createSession: false }), ctx);
    expect(result.warnings.some((warning) => warning.includes(`"${COORDINATOR_PROVIDER}"`))).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps allowed punctuation in the project name literally in all files", async () => {
    // "$" is rejected by the name pattern, so exercise the closest allowed names.
    const { context: ctx } = context();
    const result = await createProject(input({ name: "a.b_c-1" }), ctx);
    const coordinator = await readFile(path.join(result.path, ".claude/agents/coordinator.md"), "utf8");
    expect(coordinator).toContain("Project a.b_c-1");
  });

  it.each(["a b", "a/b", "../x", "$&", "-x", "", "a$1"])("rejects the invalid name %j", async (name) => {
    const { context: ctx } = context();
    await expect(createProject(input({ name }), ctx)).rejects.toThrow("Invalid project name");
    expect(await readdir(path.join(home, "projects")).catch(() => [])).toEqual([]);
  });

  it("substitutes repeated placeholders in subagent files", async () => {
    await writeFile(
      path.join(home, ".paseo-init", "presets", "agents", "developer.md"),
      "---\ndescription: Develops\n---\n{{name}} and {{name}}\n",
    );
    const { context: ctx } = context();
    const result = await createProject(input(), ctx);
    const developer = await readFile(path.join(result.path, ".claude/agents/developer.md"), "utf8");
    expect(developer).toContain("demo and demo");
    expect(developer).not.toContain("{{name}}");
  });
});
