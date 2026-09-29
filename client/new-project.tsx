import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import type { SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import {
  SettingsAction,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { ScrollView } from "react-native";
import {
  AGENT_TOOLS,
  COORDINATOR_ID,
  DELEGATION_TOOL,
  PROJECT_NAME_PATTERN,
  createProjectRpc,
  listPresetsRpc,
  mcpServerOfTool,
  mcpServerTool,
  projectsRootRpc,
} from "../shared/project";
import { AgentToolsModal } from "./agent-tools";

const NO_CLAUDE_MD = "none";

export function NewProjectSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const toast = useToast();
  const inputRef = useRef<SettingsInputHandle>(null);
  const [name, setName] = useState("");
  const [claudeMd, setClaudeMd] = useState(NO_CLAUDE_MD);
  /** Selected agents (and edited coordinator tools) by preset id; null tools inherit all tools. */
  const [agents, setAgents] = useState<Record<string, string[] | null>>({});
  const [editingAgent, setEditingAgent] = useState<string | null>(null);

  const fetchRoot = useRpc(projectsRootRpc);
  const root = useQuery({ queryKey: ["project-init", "root"], queryFn: () => fetchRoot({}) });
  const fetchPresets = useRpc(listPresetsRpc);
  const presets = useQuery({ queryKey: ["project-init", "presets"], queryFn: () => fetchPresets({}) });

  const createProject = useRpc(createProjectRpc);
  const creation = useMutation({
    mutationFn: createProject,
    onSuccess: ({ path, workspaceId, files, warnings }) => {
      const written = files.length > 0 ? ` with ${files.join(", ")}` : "";
      toast.show(`Created ${path}${written}`, { variant: "success" });
      for (const warning of warnings) toast.show(warning, { variant: "warning" });
      inputRef.current?.replaceText("");
      setName("");
      navigation?.openWorkspace({ workspaceId });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const trimmed = name.trim();
  const nameError = trimmed && !PROJECT_NAME_PATTERN.test(trimmed)
    ? "Use letters, digits, '.', '_' or '-', starting with a letter or digit"
    : null;
  const hint = root.data ? `Will be created at ${root.data.path}/${trimmed || "<name>"}` : undefined;

  const claudeMdOptions = [
    { label: "None", value: NO_CLAUDE_MD },
    ...(presets.data?.claudeMd ?? []).map((preset) => ({ label: preset.name, value: preset.id })),
  ];
  const claudeMdHint = presets.data?.claudeMd.find((preset) => preset.id === claudeMd)?.description;
  const mcpServers = presets.data?.mcpServers ?? [];
  const agentPresets = presets.data?.agents ?? [];
  const selectedAgents = agentPresets.filter((preset) => preset.id in agents);
  const agentsMissingTools = selectedAgents.some((preset) => agents[preset.id]?.length === 0);

  const coordinatorPreset = presets.data?.coordinator ?? null;
  const toolsOf = (id: string, presetTools: string[] | null) => (id in agents ? agents[id] ?? null : presetTools);
  const coordinatorTools = coordinatorPreset ? toolsOf(COORDINATOR_ID, coordinatorPreset.tools) : null;
  // Mirrors the server, which lets the coordinator start exactly the selected subagents.
  const delegation = selectedAgents.length > 0
    ? `${DELEGATION_TOOL}(${selectedAgents.map((preset) => preset.name).join(", ")})`
    : null;
  const coordinatorBlocked = !coordinatorPreset || (coordinatorTools?.length === 0 && delegation === null);

  const editedAgent = editingAgent === COORDINATOR_ID
    ? coordinatorPreset
    : agentPresets.find((preset) => preset.id === editingAgent);

  const isKnownServer = (server: string) => mcpServers.some((entry) => entry.name === server);
  const serversOf = (tools: string[] | null) =>
    [...new Set((tools ?? []).map(mcpServerOfTool).filter((server) => server !== null))];
  // Mirrors the server: .mcp.json gets the known servers referenced by the agents' tools.
  const usedServers = [
    ...new Set([
      ...serversOf(coordinatorTools),
      ...selectedAgents.flatMap((preset) => serversOf(agents[preset.id] ?? null)),
    ]),
  ].filter(isKnownServer);

  const toolOptions = (presetTools: string[] | null, current: string[] | null) => [
    ...new Set([
      ...AGENT_TOOLS,
      ...mcpServers.map((entry) => mcpServerTool(entry.name)),
      ...(presetTools ?? []),
      ...(current ?? []),
    ]),
  ];
  const toolHint = (tool: string) => {
    const server = mcpServerOfTool(tool);
    if (server === null) return undefined;
    const entry = mcpServers.find((candidate) => candidate.name === server);
    return entry ? `MCP server: ${entry.description}` : "MCP server not in the presets: it won't be added";
  };
  const agentToolsError = (tools: string[] | null) => {
    if (tools?.length === 0) return "Select at least one tool or inherit all tools";
    const unknown = serversOf(tools).filter((server) => !isKnownServer(server));
    return unknown.length > 0 ? `MCP servers not in the presets: ${unknown.join(", ")}` : null;
  };

  const toggleAgent = (id: string, enabled: boolean, presetTools: string[] | null) =>
    setAgents(({ [id]: _removed, ...rest }) => (enabled ? { ...rest, [id]: presetTools } : rest));

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 16 },
    }),
    [theme, layout.compact],
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SettingsSection title="New project">
        <SettingsInput
          ref={inputRef}
          label="Project name"
          placeholder="my-project"
          hint={hint}
          error={nameError}
          onChangeText={setName}
          disabled={creation.isPending}
        />
        <SettingsSelect
          label="CLAUDE.md"
          hint={claudeMdHint}
          value={claudeMd}
          options={claudeMdOptions}
          onValueChange={setClaudeMd}
          disabled={creation.isPending}
        />
      </SettingsSection>
      <SettingsSection title="Agents">
        {coordinatorPreset
          ? [
            <SettingsRow
              key={COORDINATOR_ID}
              label={`${coordinatorPreset.name} (always added)`}
              hint={`Runs the main Claude session. ${coordinatorPreset.description}`}
            />,
            <SettingsAction
              key={`${COORDINATOR_ID}:tools`}
              label={`${coordinatorPreset.name} · tools`}
              hint={coordinatorTools === null
                ? "All tools (inherited): can start any subagent"
                : [...coordinatorTools, delegation ?? "no subagents to delegate to"].join(", ")}
              error={coordinatorTools?.length === 0 && delegation === null
                ? "Select at least one tool, a subagent or inherit all tools"
                : coordinatorTools?.length ? agentToolsError(coordinatorTools) : null}
              actionLabel="Configure"
              onPress={() => setEditingAgent(COORDINATOR_ID)}
              disabled={creation.isPending}
            />,
          ]
          : presets.isSuccess && (
            <SettingsRow
              label="Coordinator"
              error={`Missing: add agents/${COORDINATOR_ID}.md to the presets folder`}
            />
          )}
        {agentPresets.length === 0 && (
          <SettingsRow label="No subagent presets" hint="Add agents/<id>.md to the presets folder" />
        )}
        {agentPresets.flatMap((preset) => {
          const enabled = preset.id in agents;
          const tools = agents[preset.id] ?? null;
          const row = (
            <SettingsSwitch
              key={preset.id}
              label={preset.name}
              hint={preset.description}
              value={enabled}
              onValueChange={(next) => toggleAgent(preset.id, next, preset.tools)}
              disabled={creation.isPending}
            />
          );
          if (!enabled) return [row];
          return [
            row,
            <SettingsAction
              key={`${preset.id}:tools`}
              label={`${preset.name} · tools`}
              hint={tools === null
                ? "All tools (inherited); MCP servers are not added for this agent"
                : tools.join(", ")}
              error={agentToolsError(tools)}
              actionLabel="Configure"
              onPress={() => setEditingAgent(preset.id)}
              disabled={creation.isPending}
            />,
          ];
        })}
      </SettingsSection>
      <SettingsSection title="Hooks (always added)">
        {(presets.data?.hooks ?? []).length === 0 && (
          <SettingsRow label="No hook presets" hint="Add hooks/<id>/hooks.json to the presets folder" />
        )}
        {(presets.data?.hooks ?? []).map((preset) => (
          <SettingsRow
            key={preset.id}
            label={preset.name}
            hint={`${preset.description} (${preset.events.join(", ")})`}
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Create">
        <SettingsRow
          label="MCP servers"
          hint={usedServers.length > 0
            ? `From agents' tools: ${usedServers.join(", ")}`
            : "None: no selected agent uses mcp__ tools"}
        />
        <SettingsAction
          label="Create directory and workspace"
          actionLabel={creation.isPending ? "Creating…" : "Create"}
          disabled={!trimmed || nameError !== null || agentsMissingTools || coordinatorBlocked
            || creation.isPending}
          onPress={() =>
            creation.mutate({
              name: trimmed,
              claudeMd: claudeMd === NO_CLAUDE_MD ? null : claudeMd,
              coordinator: { tools: coordinatorTools },
              agents: selectedAgents.map((preset) => ({ id: preset.id, tools: agents[preset.id] ?? null })),
            })}
        />
      </SettingsSection>
      <SettingsSection title="Presets">
        <SettingsAction
          label="Presets folder"
          hint={presets.data
            ? `${presets.data.directory}: claude-md/<id>.md, mcp/<id>.json, agents/<id>.md, hooks/<id>/`
            : undefined}
          error={presets.error ? String(presets.error) : null}
          actionLabel={presets.isFetching ? "Reloading…" : "Reload"}
          disabled={presets.isFetching}
          onPress={() => void presets.refetch()}
        />
        {(presets.data?.warnings ?? []).map((warning) => (
          <SettingsRow key={warning} label="Preset warning" error={warning} />
        ))}
      </SettingsSection>
      {editedAgent && (
        <AgentToolsModal
          agentName={editedAgent.name}
          open
          tools={toolsOf(editedAgent.id, editedAgent.tools)}
          presetTools={editedAgent.tools}
          options={toolOptions(editedAgent.tools, toolsOf(editedAgent.id, editedAgent.tools))}
          toolHint={toolHint}
          onChange={(tools) => setAgents((current) => ({ ...current, [editedAgent.id]: tools }))}
          onClose={() => setEditingAgent(null)}
        />
      )}
    </ScrollView>
  );
}
