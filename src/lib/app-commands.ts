import type { Action, AppState } from "@/state/store";
import { skillRecorderEnabled } from "@/lib/feature-flags";

export interface AppCommand {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  action: Action;
  enabled: boolean;
  disabledReason?: string;
}

export function appCommands(state: AppState): AppCommand[] {
  const selectedBot = state.bots.find((bot) => bot.id === state.selectedId && !bot.hidden);
  const needsBot = "Select a bot first";
  return [
    { id: "new-bot", name: "New bot", description: "Create another bot", keywords: ["create", "agent"], action: { type: "newBot" }, enabled: true },
    { id: "new-task", name: "New task", description: "Start a fresh task for this bot", keywords: ["conversation", "thread"], action: { type: "newTask", botId: selectedBot?.id ?? "" }, enabled: Boolean(selectedBot), ...(!selectedBot ? { disabledReason: needsBot } : {}) },
    { id: "computer", name: "Open computer", description: "Show this bot's desktop", keywords: ["screen", "desktop", "control"], action: { type: "toggleComputer", open: true }, enabled: Boolean(selectedBot), ...(!selectedBot ? { disabledReason: needsBot } : {}) },
    { id: "bot-settings", name: "Bot settings", description: "Model, computer, permissions, and profile", keywords: ["model", "permission", "persona"], action: { type: "toggleSettings", open: true }, enabled: Boolean(selectedBot), ...(!selectedBot ? { disabledReason: needsBot } : {}) },
    { id: "routines", name: "Open routines", description: "Scheduled and recurring work", keywords: ["automation", "schedule"], action: { type: "showRoutines" }, enabled: true },
    { id: "team-map", name: "Open team map", description: "See bots and their relationships", keywords: ["organization", "agents"], action: { type: "showTeamMap" }, enabled: true },
    { id: "connected-apps", name: "Connected apps", description: "Manage tools and app connections", keywords: ["plugins", "connectors", "mcp"], action: { type: "togglePlugins", open: true }, enabled: true },
    { id: "app-settings", name: "App settings", description: "General settings", keywords: ["preferences", "profile"], action: { type: "toggleAppSettings", open: true, section: "general" }, enabled: true },
    { id: "connections", name: "Connection settings", description: "API keys and remote services", keywords: ["keys", "vps", "composio"], action: { type: "toggleAppSettings", open: true, section: "connections" }, enabled: true },
    { id: "engines", name: "Engine settings", description: "Harnesses, providers, and models", keywords: ["models", "harness", "provider"], action: { type: "toggleAppSettings", open: true, section: "engines" }, enabled: true },
    { id: "local-vm", name: "Local VM settings", description: "Desktop isolation and capacity", keywords: ["computer", "virtual machine"], action: { type: "toggleAppSettings", open: true, section: "computer" }, enabled: true },
    { id: "skill-recorder", name: "Teach a skill", description: "Record a desktop workflow", keywords: ["workflow", "recorder"], action: { type: "showSkillRecorder" }, enabled: skillRecorderEnabled(state.config), ...(!skillRecorderEnabled(state.config) ? { disabledReason: "Enable it in Experimental features" } : {}) },
  ];
}

export function matchingAppCommands(commands: readonly AppCommand[], query: string): AppCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  const score = (command: AppCommand): number => {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    if ([command.description, ...command.keywords].some((value) => value.toLowerCase().includes(needle))) return 2;
    return 3;
  };
  return commands
    .map((command, index) => ({ command, index, score: score(command) }))
    .filter((entry) => entry.score < 3)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.command);
}
