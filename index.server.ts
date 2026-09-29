import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProject, listPresets, projectsRoot } from "./server/project";
import { createProjectRpc, listPresetsRpc, projectsRootRpc } from "./shared/project";

export default function contribute(server: PluginServerContext) {
  server.handle(createProjectRpc, createProject);
  server.handle(projectsRootRpc, () => ({ path: projectsRoot() }));
  server.handle(listPresetsRpc, listPresets);
  return () => {};
}
