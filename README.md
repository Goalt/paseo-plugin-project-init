# project-init

Paseo plugin that creates a project directory in `~/projects`, fills it with Claude Code
configuration from your presets and registers it as a Paseo workspace.

Open it from the sidebar or the command center: **New project**.

The new directory is a git repository on `main` with the generated files in an initial commit
(`.claude/settings.local.json` is ignored). If git is missing or the commit fails, for example
because `user.name`/`user.email` aren't set, the project is still created and the form shows a warning.

## Install

```sh
npm install
paseo daemon config set pluginsEnabled true
paseo plugin install /path/to/project-init-plugin
# after code changes
paseo plugin reload project-init
```

## Presets

Presets live in `~/.paseo-init/presets` (`claude-md/`, `mcp/`, `agents/`, `hooks/`); the plugin ships none. They are read every time
the form loads or you press **Reload** in the Presets section, so no plugin reload is
needed. Invalid files are skipped and listed in the form.

The preset id is the file name without its extension (letters, digits, `.`, `_`, `-`).

### `claude-md/<id>.md`

A `CLAUDE.md` template. Frontmatter is optional; `{{name}}` is replaced with the project name.

```markdown
---
name: Paseo (RU)
description: Russian template for projects driven by Paseo agents
---
# {{name}}

## Rules
- Answer in Russian.
```

### `mcp/<id>.json`

A library of MCP servers in the same shape as `.mcp.json`; the form does not list them.
A server is added to the project's `.mcp.json` (and `enabledMcpjsonServers`) when a selected
agent has a `mcp__<server>` or `mcp__<server>__<tool>` tool. Keep one server per file; if two
files define the same server differently, the first file by name wins and the form shows a
warning. Use `${VAR}` for secrets and paths; Claude Code expands them from the environment.

```json
{
  "name": "Context7",
  "description": "Up-to-date library documentation and code examples",
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
  }
}
```

### `agents/<id>.md`

A Claude Code subagent file, written to `.claude/agents/<id>.md`. `description` is required;
`name` defaults to the id. Every frontmatter line is kept as written except `tools`.

```markdown
---
name: code-reviewer
description: Reviews recent changes. Use after writing or modifying code.
tools: Read, Glob, Grep, Bash
model: sonnet
---

You are a senior code reviewer...
```

`tools` (a comma list or a YAML list) is the default selection in the form; without it the
agent inherits all tools. In the form each selected agent has **Configure**, where you can
switch to "inherit all tools" or pick tools: the Claude Code built-ins plus `mcp__<server>`
for every server in `mcp/`, which grants all tools of that server and adds the server to the
project. Agents that inherit all tools don't add MCP servers.

### Coordinator: `agents/coordinator.md`

Required and always added. It is written to `.claude/agents/`, but `.claude/settings.json` gets no
`agent` key: that would make every Paseo agent started in the project run as the coordinator and
delegate endlessly. The coordinator runs as the main session of a separate Paseo provider, see
[Running the coordinator](#running-the-coordinator). Subagents cannot start other subagents, so
delegation only works from this main session.

- The plugin adds `Task(<selected subagents>)` to the coordinator's tools, so it can start exactly
  the project's subagents. `Task`/`Agent` entries in presets are ignored.
- Its other tools are configured in the form like any agent's, and its `mcp__*` tools add MCP servers.
  If it inherits all tools, it can start any subagent.
- `{{agents}}` in the body is replaced with the list of selected subagents; without the placeholder
  the list is appended as a "Subagents" section.
- `{{name}}` is replaced with the project name (trimmed) in every agent body, like in `claude-md/`
  templates.

### Running the coordinator

The coordinator needs the Paseo provider `claude-coordinator`. Add it to `~/.paseo/config.json`
(the plugin never edits that file):

```json
{
  "agents": {
    "providers": {
      "claude-coordinator": {
        "extends": "claude",
        "label": "Claude Coordinator",
        "description": "Claude Code launched with --agent coordinator",
        "command": ["/usr/local/bin/claude", "--agent", "coordinator"]
      }
    }
  }
}
```

If the provider is missing (or has `"enabled": false`, which counts as missing), the project is
still created and the result carries a warning with this fragment. With the **Create coordinator
session** switch on (the default) and the provider present, the plugin starts a
`claude-coordinator` agent (model `claude-opus-5-5`, mode `auto`) in the new workspace with a short
greeting. A failure to start it is only a warning.

Migrating older projects: delete the `"agent": "coordinator"` line from `.claude/settings.json`.

### `hooks/<id>/`

Claude Code hooks, always added to every project. `hooks.json` holds a fragment of the `hooks`
setting; the other files of the directory (scripts) are copied to `.claude/hooks/`, so refer to them
as `$CLAUDE_PROJECT_DIR/.claude/hooks/<file>`. Matchers of all presets are merged per event into
`.claude/settings.json`. Script file names must be unique across presets; a clashing preset is
skipped with a warning.

```json
{
  "name": "Only project agents",
  "description": "Blocks subagents that are not defined in .claude/agents/",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Agent|Task",
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/only-project-agents.mjs\"" }
        ]
      }
    ]
  }
}
```

## Development

`npm run typecheck` and `npm test` (the tests need `git` installed).
