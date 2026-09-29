import type { PluginClientContext } from "@getpaseo/plugin/client";
import { NewProjectSurface } from "./client/new-project";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addSurface("new-project", NewProjectSurface),
    client.addSidebarItem({
      id: "new-project",
      title: "New project",
      icon: "FolderPlus",
      surface: "new-project",
    }),
    client.addCommandCenterItem({
      id: "new-project",
      title: "New project",
      icon: "FolderPlus",
      keywords: ["create", "project", "workspace", "directory"],
      context: "global",
      onSelect: (context) => context.openSurface("new-project"),
    }),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
