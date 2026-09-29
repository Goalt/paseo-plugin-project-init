import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import {
  COORDINATOR_ID,
  DELEGATION_TOOL,
  PROJECT_NAME_PATTERN,
  type PresetSummary,
  createProjectRpc,
  mcpServerOfTool,
} from "../shared/project";
import { type AgentPreset, type HookPreset, type McpServerEntry, loadPresetCatalog } from "./presets";

export function projectsRoot(): string {
  return path.join(homedir(), "projects");
}

export async function listPresets() {
  const { directory, claudeMd, mcpServers, agents, hooks, warnings } = await loadPresetCatalog();
  const coordinator = agents.find((preset) => preset.id === COORDINATOR_ID);
  const summary = ({ id, name, description }: PresetSummary) => ({ id, name, description });
  return {
    directory,
    claudeMd: claudeMd.map(summary),
    mcpServers: mcpServers.map(({ name, description }) => ({ name, description })),
    coordinator: coordinator ? { ...summary(coordinator), tools: coordinator.tools } : null,
    agents: agents
      .filter((preset) => preset.id !== COORDINATOR_ID)
      .map((preset) => ({ ...summary(preset), tools: preset.tools })),
    hooks: hooks.map((preset) => ({ ...summary(preset), events: Object.keys(preset.hooks) })),
    warnings,
  };
}

function findPreset<T extends { id: string }>(presets: T[], id: string, kind: string): T {
  const preset = presets.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown ${kind} preset: ${id}`);
  return preset;
}

interface UsedMcpServer {
  entry: McpServerEntry;
  agents: string[];
}

const agentLine = (preset: AgentPreset) => `- \`${preset.name}\` — ${preset.description}`;

function renderClaudeMd(
  template: string,
  coordinator: AgentPreset,
  agents: AgentPreset[],
  mcp: UsedMcpServer[],
  hooks: HookPreset[],
): string {
  const section = (title: string, lines: string[]) =>
    lines.length === 0 ? "" : `\n## ${title}\n${lines.join("\n")}\n`;
  return template
    + section("Agents", [`${agentLine(coordinator)} (main session)`, ...agents.map(agentLine)])
    + section("MCP servers", mcp.map(({ entry, agents: users }) =>
      `- \`${entry.name}\` — ${entry.description} (used by ${users.join(", ")})`))
    + section("Hooks", hooks.map((preset) =>
      `- \`${preset.name}\` — ${preset.description} (${Object.keys(preset.hooks).join(", ")})`));
}

/** Concatenates the matchers of all hook presets per event. */
function mergeHooks(presets: HookPreset[]) {
  const merged: HookPreset["hooks"] = {};
  for (const preset of presets) {
    for (const [event, matchers] of Object.entries(preset.hooks)) {
      merged[event] = [...(merged[event] ?? []), ...matchers];
    }
  }
  return merged;
}

/** MCP servers referenced by the agents' `mcp__*` tools; agents inheriting all tools add none. */
function collectUsedMcpServers(
  agents: { preset: AgentPreset; tools: string[] | null }[],
  known: McpServerEntry[],
  warnings: string[],
): UsedMcpServer[] {
  const used = new Map<string, UsedMcpServer>();
  for (const { preset, tools } of agents) {
    for (const server of new Set((tools ?? []).map(mcpServerOfTool))) {
      if (server === null) continue;
      const entry = known.find((candidate) => candidate.name === server);
      if (!entry) {
        warnings.push(`Agent ${preset.name}: MCP server "${server}" is not in the presets, not added to .mcp.json`);
        continue;
      }
      const usage = used.get(server) ?? { entry, agents: [] };
      usage.agents.push(preset.name);
      used.set(server, usage);
    }
  }
  return [...used.values()];
}

function git(cwd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 10_000 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const detail = (error as NodeJS.ErrnoException).code === "ENOENT" ? "git is not installed" : stderr.trim();
      reject(new Error(detail || error.message));
    });
  });
}

/** Creates a repository with the generated files committed; git problems become warnings. */
async function initGit(cwd: string, warnings: string[]) {
  try {
    await git(cwd, ["init", "--quiet", "--initial-branch=main"]);
  } catch (error) {
    warnings.push(`git init failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    await git(cwd, ["add", "--all"]);
    await git(cwd, ["commit", "--quiet", "--message", "Initial project setup"]);
  } catch (error) {
    warnings.push(`Initial commit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeProjectFile(root: string, relativePath: string, content: string) {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

export async function createProject(
  { name, claudeMd, coordinator, agents }: RpcInput<typeof createProjectRpc>,
  { paseo }: PluginHandlerContext,
) {
  const trimmed = name.trim();
  if (!PROJECT_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      "Invalid project name: use letters, digits, '.', '_' or '-', starting with a letter or digit",
    );
  }
  // Resolve presets before touching the filesystem so bad input creates nothing.
  const catalog = await loadPresetCatalog();
  const claudeMdPreset = claudeMd === null ? null : findPreset(catalog.claudeMd, claudeMd, "CLAUDE.md");
  const coordinatorPreset = catalog.agents.find((preset) => preset.id === COORDINATOR_ID);
  if (!coordinatorPreset) {
    throw new Error(`Coordinator preset is missing: add agents/${COORDINATOR_ID}.md to ${catalog.directory}`);
  }
  const selectedAgents = agents.filter(({ id }) => id !== COORDINATOR_ID).map(({ id, tools }) => {
    const preset = findPreset(catalog.agents, id, "agent");
    if (tools?.length === 0) {
      throw new Error(`Agent ${preset.name} needs at least one tool, or inherit all tools`);
    }
    return { preset, tools };
  });
  // The coordinator may start exactly the selected subagents; inheriting all tools keeps it unrestricted.
  const delegation = selectedAgents.length > 0
    ? [`${DELEGATION_TOOL}(${selectedAgents.map(({ preset }) => preset.name).join(", ")})`]
    : [];
  const coordinatorTools = coordinator.tools && [...new Set(coordinator.tools), ...delegation];
  if (coordinatorTools?.length === 0) {
    throw new Error("The coordinator needs at least one tool, a subagent to delegate to, or all tools");
  }

  const warnings: string[] = [];
  const usedMcp = collectUsedMcpServers(
    [{ preset: coordinatorPreset, tools: coordinator.tools }, ...selectedAgents],
    catalog.mcpServers,
    warnings,
  );

  const root = projectsRoot();
  const target = path.join(root, trimmed);
  await mkdir(root, { recursive: true });
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Directory already exists: ${target}`);
    }
    throw error;
  }

  const files: Record<string, string> = {};
  if (claudeMdPreset) {
    files["CLAUDE.md"] = renderClaudeMd(
      claudeMdPreset.render(trimmed),
      coordinatorPreset,
      selectedAgents.map(({ preset }) => preset),
      usedMcp,
      catalog.hooks,
    );
  }
  const subagentList = selectedAgents.length > 0
    ? selectedAgents.map(({ preset }) => agentLine(preset)).join("\n")
    : "No subagents in this project: do the work yourself.";
  files[`.claude/agents/${coordinatorPreset.id}.md`] = coordinatorPreset.render(
    coordinatorTools,
    (body) => body.includes("{{agents}}")
      ? body.replaceAll("{{agents}}", subagentList)
      : `${body.trimEnd()}\n\n## Subagents\n${subagentList}\n`,
  );
  for (const { preset, tools } of selectedAgents) {
    files[`.claude/agents/${preset.id}.md`] = preset.render(tools && [...new Set(tools)]);
  }
  // `agent` makes the main Claude session, including Paseo agents, run as the coordinator.
  const settings: Record<string, unknown> = { agent: coordinatorPreset.name };
  if (usedMcp.length > 0) {
    const mcpServers = Object.fromEntries(usedMcp.map(({ entry }) => [entry.name, entry.config]));
    files[".mcp.json"] = `${JSON.stringify({ mcpServers }, null, 2)}\n`;
    // Pre-approve project servers so Claude Code starts them without a trust prompt.
    settings.enabledMcpjsonServers = Object.keys(mcpServers);
  }
  // Every hook preset is added: scripts go to .claude/hooks/, matchers into the hooks setting.
  if (catalog.hooks.length > 0) {
    settings.hooks = mergeHooks(catalog.hooks);
    for (const preset of catalog.hooks) {
      for (const [fileName, content] of Object.entries(preset.files)) {
        files[`.claude/hooks/${fileName}`] = content;
      }
    }
  }
  files[".claude/settings.json"] = `${JSON.stringify(settings, null, 2)}\n`;
  files[".gitignore"] = ".claude/settings.local.json\n";

  try {
    for (const [relativePath, content] of Object.entries(files)) {
      await writeProjectFile(target, relativePath, content);
    }
    // Before opening the workspace, so Paseo registers the project as a git repository.
    await initGit(target, warnings);
    const workspace = await paseo.workspaces.open(target);
    return { path: target, workspaceId: workspace.id, files: Object.keys(files), warnings };
  } catch (error) {
    // The directory was created by this call, so remove it with whatever was written.
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
