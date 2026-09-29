import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { TOOL_NAME_PATTERN, isDelegationTool } from "../shared/project";

const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const McpServerSchema = z.union([
  z.looseObject({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.looseObject({
    type: z.enum(["http", "sse"]),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  }),
], { error: 'expected "command" (stdio) or "type": "http" | "sse" with "url"' });

const McpPresetFileSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  mcpServers: z.record(z.string().min(1), McpServerSchema).refine(
    (servers) => Object.keys(servers).length > 0,
    "mcpServers must contain at least one server",
  ),
});

export type McpServerConfig = z.infer<typeof McpServerSchema>;

/** `hooks.json` of a hook preset: a fragment of the `hooks` setting of `.claude/settings.json`. */
const HookPresetFileSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  hooks: z.record(
    z.string().min(1),
    z.array(z.looseObject({
      matcher: z.string().optional(),
      hooks: z.array(z.looseObject({ type: z.string().min(1) })).min(1),
    })).min(1),
  ),
});

type HookMatchers = z.infer<typeof HookPresetFileSchema>["hooks"];

export interface HookPreset {
  id: string;
  name: string;
  description: string;
  /** Hook matchers by event name, merged into the project's settings. */
  hooks: HookMatchers;
  /** Other files of the preset directory by file name, copied to `.claude/hooks/`. */
  files: Record<string, string>;
}

export interface ClaudeMdPreset {
  id: string;
  name: string;
  description: string;
  render(projectName: string): string;
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  servers: Record<string, McpServerConfig>;
}

export interface AgentPreset {
  id: string;
  name: string;
  description: string;
  /** Tools from the preset's frontmatter; null means the agent inherits all tools. */
  tools: string[] | null;
  render(tools: string[] | null, transformBody?: (body: string) => string): string;
}

/** One MCP server from the mcp/ presets, looked up by name from agents' `mcp__<server>` tools. */
export interface McpServerEntry {
  name: string;
  description: string;
  config: McpServerConfig;
}

export interface PresetCatalog {
  directory: string;
  claudeMd: ClaudeMdPreset[];
  mcpServers: McpServerEntry[];
  agents: AgentPreset[];
  hooks: HookPreset[];
  warnings: string[];
}

export function presetsDir(): string {
  return path.join(homedir(), ".paseo-init", "presets");
}

interface Frontmatter {
  /** Top-level `key: value` pairs. */
  attributes: Record<string, string>;
  /** Raw frontmatter lines, kept so presets can be written back verbatim. */
  lines: string[];
  body: string;
}

/** Splits optional `---` frontmatter of flat `key: value` lines from the body. */
function parseFrontmatter(content: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { attributes: {}, lines: [], body: content };
  const lines = match[1].split(/\r?\n/);
  const attributes: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0 || /^[\s-]/.test(line)) continue;
    attributes[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { attributes, lines, body: content.slice(match[0].length) };
}

const isToolsKey = (line: string) => /^tools\s*:/.test(line);
const isListItem = (line: string) => /^\s*-\s/.test(line);

/** Reads `tools: A, B` or a YAML list under `tools:`; null when the key is absent. */
function parseTools(lines: string[]): string[] | null {
  const index = lines.findIndex(isToolsKey);
  if (index === -1) return null;
  const inline = lines[index].slice(lines[index].indexOf(":") + 1).trim();
  // Commas inside parentheses belong to one tool, e.g. `Task(worker, researcher)`.
  const items = inline ? inline.replace(/^\[|\]$/g, "").split(/,(?![^(]*\))/) : [];
  if (!inline) {
    for (const line of lines.slice(index + 1)) {
      if (!isListItem(line)) break;
      items.push(line.replace(/^\s*-\s*/, ""));
    }
  }
  return items.map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** Rebuilds agent frontmatter with the given tools, keeping every other line as written. */
function renderAgent(
  id: string,
  { attributes, lines, body }: Frontmatter,
  tools: string[] | null,
  transformBody: (body: string) => string = (text) => text,
) {
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isToolsKey(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    while (i + 1 < lines.length && isListItem(lines[i + 1])) i++;
  }
  if (!attributes.name) kept.unshift(`name: ${id}`);
  if (tools) kept.push(`tools: ${tools.join(", ")}`);
  return `---\n${kept.join("\n")}\n---\n${transformBody(body)}`;
}

/** Lists `<id><extension>` files in a directory; a missing directory has no presets. */
async function listPresetFiles(directory: string, extension: string, warnings: string[]) {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: { id: string; file: string }[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(extension)) continue;
    const id = entry.slice(0, -extension.length);
    if (!PRESET_ID_PATTERN.test(id)) {
      warnings.push(`${path.join(directory, entry)}: invalid preset id "${id}"`);
      continue;
    }
    files.push({ id, file: path.join(directory, entry) });
  }
  return files;
}

async function loadClaudeMdPresets(directory: string, warnings: string[]) {
  const presets: ClaudeMdPreset[] = [];
  for (const { id, file } of await listPresetFiles(directory, ".md", warnings)) {
    try {
      const { attributes, body } = parseFrontmatter(await readFile(file, "utf8"));
      presets.push({
        id,
        name: attributes.name || id,
        description: attributes.description || `Template from ${file}`,
        render: (projectName) => body.replaceAll("{{name}}", projectName),
      });
    } catch (error) {
      warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return presets;
}

async function loadAgentPresets(directory: string, warnings: string[]) {
  const presets: AgentPreset[] = [];
  for (const { id, file } of await listPresetFiles(directory, ".md", warnings)) {
    try {
      const frontmatter = parseFrontmatter(await readFile(file, "utf8"));
      const { name, description } = frontmatter.attributes;
      if (!description) {
        warnings.push(`${file}: frontmatter needs a "description" so Claude knows when to use the agent`);
        continue;
      }
      // Delegation tools are dropped: subagents can't delegate and the coordinator gets one generated.
      const tools = parseTools(frontmatter.lines)?.filter((tool) => {
        if (isDelegationTool(tool)) return false;
        if (TOOL_NAME_PATTERN.test(tool)) return true;
        warnings.push(`${file}: unsupported tool "${tool}" ignored`);
        return false;
      }) ?? null;
      presets.push({
        id,
        name: name || id,
        description,
        tools,
        render: (selected, transformBody) => renderAgent(id, frontmatter, selected, transformBody),
      });
    } catch (error) {
      warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return presets;
}

async function loadMcpPresets(directory: string, warnings: string[]) {
  const presets: McpPreset[] = [];
  for (const { id, file } of await listPresetFiles(directory, ".json", warnings)) {
    try {
      const parsed = McpPresetFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (!parsed.success) {
        warnings.push(`${file}: ${z.prettifyError(parsed.error)}`);
        continue;
      }
      presets.push({
        id,
        name: parsed.data.name ?? id,
        description: parsed.data.description ?? `Servers from ${file}`,
        servers: parsed.data.mcpServers,
      });
    } catch (error) {
      warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return presets;
}

const HOOKS_FILE = "hooks.json";

/** Loads `hooks/<id>/hooks.json` presets; a script name used by two presets skips the later one. */
async function loadHookPresets(directory: string, warnings: string[]) {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const presets: HookPreset[] = [];
  const fileOwners = new Map<string, string>();
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const id = entry.name;
    const presetDir = path.join(directory, id);
    if (!PRESET_ID_PATTERN.test(id)) {
      warnings.push(`${presetDir}: invalid preset id "${id}"`);
      continue;
    }
    try {
      const parsed = HookPresetFileSchema.safeParse(
        JSON.parse(await readFile(path.join(presetDir, HOOKS_FILE), "utf8")),
      );
      if (!parsed.success) {
        warnings.push(`${path.join(presetDir, HOOKS_FILE)}: ${z.prettifyError(parsed.error)}`);
        continue;
      }
      const files: Record<string, string> = {};
      for (const file of await readdir(presetDir, { withFileTypes: true })) {
        if (!file.isFile() || file.name === HOOKS_FILE) continue;
        files[file.name] = await readFile(path.join(presetDir, file.name), "utf8");
      }
      const clash = Object.keys(files).find((name) => fileOwners.has(name));
      if (clash) {
        warnings.push(`${presetDir}: file "${clash}" is also in hooks/${fileOwners.get(clash)}, preset skipped`);
        continue;
      }
      for (const name of Object.keys(files)) fileOwners.set(name, id);
      presets.push({
        id,
        name: parsed.data.name ?? id,
        description: parsed.data.description ?? `Hooks from ${presetDir}`,
        hooks: parsed.data.hooks,
        files,
      });
    } catch (error) {
      warnings.push(`${presetDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return presets;
}

/** Flattens MCP presets into servers by name; the first file (by name) defining a server wins. */
function collectMcpServers(presets: McpPreset[], warnings: string[]): McpServerEntry[] {
  const servers = new Map<string, McpServerEntry & { presetId: string }>();
  for (const preset of presets) {
    for (const [name, config] of Object.entries(preset.servers)) {
      const existing = servers.get(name);
      if (!existing) {
        servers.set(name, { name, description: preset.description, config, presetId: preset.id });
      } else if (JSON.stringify(existing.config) !== JSON.stringify(config)) {
        warnings.push(
          `MCP server "${name}" is defined differently in mcp/${existing.presetId}.json and `
            + `mcp/${preset.id}.json; using mcp/${existing.presetId}.json`,
        );
      }
    }
  }
  return [...servers.values()].map(({ presetId: _presetId, ...entry }) => entry);
}

// Read on every call so edits in the presets directory apply without reloading the plugin.
export async function loadPresetCatalog(): Promise<PresetCatalog> {
  const directory = presetsDir();
  const warnings: string[] = [];
  const [claudeMd, mcp, agents, hooks] = await Promise.all([
    loadClaudeMdPresets(path.join(directory, "claude-md"), warnings),
    loadMcpPresets(path.join(directory, "mcp"), warnings),
    loadAgentPresets(path.join(directory, "agents"), warnings),
    loadHookPresets(path.join(directory, "hooks"), warnings),
  ]);
  return { directory, claudeMd, mcpServers: collectMcpServers(mcp, warnings), agents, hooks, warnings };
}
