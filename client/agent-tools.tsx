import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";

// Read-only starting point when switching an agent without preset tools off "inherit".
const DEFAULT_TOOLS = ["Read", "Glob", "Grep"];

export interface AgentToolsModalProps {
  agentName: string;
  open: boolean;
  /** null means the agent inherits all tools. */
  tools: string[] | null;
  presetTools: string[] | null;
  options: string[];
  toolHint(tool: string): string | undefined;
  onChange(tools: string[] | null): void;
  onClose(): void;
}

export function AgentToolsModal(props: AgentToolsModalProps) {
  const { agentName, open, tools, presetTools, options, toolHint, onChange, onClose } = props;

  const toggle = (tool: string, enabled: boolean) => {
    if (tools === null) return;
    // Keep the order of the options list so the generated `tools:` line is stable.
    onChange(options.filter((option) => (option === tool ? enabled : tools.includes(option))));
  };

  return (
    <Modal
      title={`Tools: ${agentName}`}
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content>
        <SettingsSection title="Access">
          <SettingsSwitch
            label="Inherit all tools"
            hint="The agent gets every tool of the main session; no MCP servers are added for it"
            value={tools === null}
            onValueChange={(inherit) => onChange(inherit ? null : presetTools ?? DEFAULT_TOOLS)}
          />
        </SettingsSection>
        {tools !== null && (
          <SettingsSection title="Tools">
            {options.map((tool) => (
              <SettingsSwitch
                key={tool}
                label={tool}
                hint={toolHint(tool)}
                value={tools.includes(tool)}
                onValueChange={(enabled) => toggle(tool, enabled)}
              />
            ))}
          </SettingsSection>
        )}
      </Modal.Content>
    </Modal>
  );
}
