import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Claude Code tools offered for agents, besides `mcp__<server>` for every known MCP server. */
export const AGENT_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Skill",
] as const;

/** Agent preset that is always added; it runs as the main session of the coordinator provider. */
export const COORDINATOR_ID = "coordinator";

/** Paseo provider that starts Claude Code with `--agent coordinator`; it lives in ~/.paseo/config.json. */
export const COORDINATOR_PROVIDER = "claude-coordinator";
export const COORDINATOR_MODEL = "claude-opus-5-5";
export const COORDINATOR_MODE = "auto";

/** The `agents.providers` entry that Paseo needs for the coordinator provider. */
export const COORDINATOR_PROVIDER_CONFIG = {
  extends: "claude",
  label: "Claude Coordinator",
  description: `Claude Code launched with --agent ${COORDINATOR_ID}`,
  command: ["/usr/local/bin/claude", "--agent", COORDINATOR_ID],
};

/** Tool that lets the main session start subagents; managed by the plugin for the coordinator. */
export const DELEGATION_TOOL = "Task";
export const isDelegationTool = (tool: string) => /^(Task|Agent)(\(.*\))?$/.test(tool);

export const mcpServerTool = (server: string) => `mcp__${server}`;

/** Server name of an `mcp__<server>` or `mcp__<server>__<tool>` tool, otherwise null. */
export const mcpServerOfTool = (tool: string) => /^mcp__(.+?)(?:__.+)?$/.exec(tool)?.[1] ?? null;

const PresetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});

export type PresetSummary = z.infer<typeof PresetSummarySchema>;

const ToolsSchema = z.array(z.string().regex(TOOL_NAME_PATTERN)).nullable();

export const createProjectRpc = defineRpc({
  name: "project.create",
  input: z.object({
    name: z.string(),
    claudeMd: z.string().nullable(),
    /** Coordinator tools without the delegation tool, which the plugin adds; null inherits all. */
    coordinator: z.object({ tools: ToolsSchema }),
    /** tools: null inherits all tools. */
    agents: z.array(z.object({ id: z.string(), tools: ToolsSchema })),
    /** Start a coordinator session in the new workspace, if the coordinator provider exists. */
    createSession: z.boolean(),
  }),
  output: z.object({
    path: z.string(),
    workspaceId: z.string(),
    files: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
});

export const projectsRootRpc = defineRpc({
  name: "project.root",
  input: z.object({}),
  output: z.object({ path: z.string() }),
});

export const listPresetsRpc = defineRpc({
  name: "presets.list",
  input: z.object({}),
  output: z.object({
    directory: z.string(),
    claudeMd: z.array(PresetSummarySchema),
    mcpServers: z.array(z.object({ name: z.string(), description: z.string() })),
    coordinator: PresetSummarySchema.extend({ tools: ToolsSchema }).nullable(),
    agents: z.array(PresetSummarySchema.extend({ tools: ToolsSchema })),
    hooks: z.array(PresetSummarySchema.extend({ events: z.array(z.string()) })),
    warnings: z.array(z.string()),
  }),
});
