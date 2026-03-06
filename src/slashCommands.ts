import type { BetterSimTrackerSettings, STContext, StatKey } from "./types";

type SlashRegisterObject = (command: Record<string, unknown>) => void;

type SlashCommandDeps = {
  getContext: () => STContext | null;
  getSettings: () => BetterSimTrackerSettings | null;
  setSettings: (next: BetterSimTrackerSettings) => void;
  getLatestMessageIndex: () => number | null;
  isExtracting: () => boolean;
  runExtraction: (reason: string, messageIndex?: number) => Promise<void>;
  refreshFromStoredData: () => void;
  clearCurrentChat: () => void;
  queuePromptSync: (context: STContext) => void;
  saveSettings: (context: STContext, next: BetterSimTrackerSettings) => void;
  pushTrace?: (event: string, details?: Record<string, unknown>) => void;
};

const COMMAND_PREFIX = "/bst";

function notify(message: string, type: "info" | "success" | "warning" | "error" = "info"): void {
  const anyGlobal = globalThis as unknown as Record<string, unknown>;
  const toastr = anyGlobal.toastr as Record<string, unknown> | undefined;
  const handler = toastr?.[type];
  if (typeof handler === "function") {
    handler(message, "BetterSimTracker");
  } else {
    console.log(`[BetterSimTracker] ${message}`);
  }
}

function parseArgs(raw: string): string[] {
  if (!raw) return [];
  return raw.trim().split(/\s+/).filter(Boolean);
}

function formatEnabledStats(settings: BetterSimTrackerSettings): string {
  const enabled: string[] = [];
  if (settings.trackAffection) enabled.push("affection");
  if (settings.trackTrust) enabled.push("trust");
  if (settings.trackDesire) enabled.push("desire");
  if (settings.trackConnection) enabled.push("connection");
  if (settings.trackMood) enabled.push("mood");
  if (settings.trackLastThought) enabled.push("lastThought");
  for (const stat of settings.customStats ?? []) {
    if (!stat.track) continue;
    enabled.push(stat.id);
  }
  return enabled.length ? enabled.join(", ") : "none";
}

function resolveBuiltInToggleKey(raw: string): StatKey | null {
  const key = raw.toLowerCase();
  if (key === "affection") return "affection";
  if (key === "trust") return "trust";
  if (key === "desire") return "desire";
  if (key === "connection") return "connection";
  if (key === "mood") return "mood";
  if (key === "lastthought" || key === "last_thought" || key === "thought") return "lastThought";
  return null;
}

function updateSetting(settings: BetterSimTrackerSettings, key: StatKey, next: boolean): BetterSimTrackerSettings {
  const copy = { ...settings };
  if (key === "affection") copy.trackAffection = next;
  if (key === "trust") copy.trackTrust = next;
  if (key === "desire") copy.trackDesire = next;
  if (key === "connection") copy.trackConnection = next;
  if (key === "mood") copy.trackMood = next;
  if (key === "lastThought") copy.trackLastThought = next;
  return copy;
}

function updateCustomTrackSetting(
  settings: BetterSimTrackerSettings,
  id: string,
  next: boolean,
): BetterSimTrackerSettings {
  const normalized = id.trim().toLowerCase();
  return {
    ...settings,
    customStats: (settings.customStats ?? []).map(stat =>
      stat.id === normalized ? { ...stat, track: next } : stat),
  };
}

function coerceArgs(raw: unknown): string {
  if (Array.isArray(raw)) return raw.join(" ");
  if (raw == null) return "";
  return String(raw);
}

function renderHelp(): string {
  return [
    "指令列表:",
    `${COMMAND_PREFIX} status`,
    `${COMMAND_PREFIX} extract`,
    `${COMMAND_PREFIX} clear`,
    `${COMMAND_PREFIX} toggle <stat>`,
    `${COMMAND_PREFIX} inject on|off`,
    `${COMMAND_PREFIX} debug on|off`,
  ].join(" ");
}

export function registerSlashCommands(deps: SlashCommandDeps): void {
  const attemptRegister = (): boolean => {
    const context = deps.getContext();
    if (!context) return false;
    const anyContext = context as unknown as Record<string, unknown>;
    const SlashCommandParser = anyContext.SlashCommandParser as { addCommandObject?: SlashRegisterObject } | undefined;
    const SlashCommand = anyContext.SlashCommand as { fromProps?: (props: Record<string, unknown>) => Record<string, unknown> } | undefined;
    const ARGUMENT_TYPE = anyContext.ARGUMENT_TYPE as { STRING?: string } | undefined;
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return false;

  const withContext = (): { context: STContext; settings: BetterSimTrackerSettings } | null => {
    const context = deps.getContext();
    const settings = deps.getSettings();
    if (!context || !settings) return null;
    return { context, settings };
  };

  const handleStatus = (): void => {
    const resolved = withContext();
    if (!resolved) {
      notify("追蹤器尚未就緒。", "warning");
      return;
    }
    const { settings } = resolved;
    const enabled = formatEnabledStats(settings);
    const mode = settings.sequentialExtraction ? "循序" : "統一";
    const inject = settings.injectTrackerIntoPrompt ? "開啟" : "關閉";
    const debug = settings.debug ? "開啟" : "關閉";
    const latestIndex = deps.getLatestMessageIndex();
    notify(`狀態: stats=${enabled}; mode=${mode}; inject=${inject}; debug=${debug}; last=${latestIndex ?? "無"}`);
  };

  const handleExtract = async (): Promise<void> => {
    if (deps.isExtracting()) {
      notify("提取正在進行中。", "warning");
      return;
    }
    await deps.runExtraction("manual_refresh");
  };

  const handleClear = (): void => {
    deps.clearCurrentChat();
    notify("已清除目前對話的追蹤資料。", "success");
  };

  const handleToggle = (args: string[]): void => {
    const resolved = withContext();
    if (!resolved) {
      notify("追蹤器尚未就緒。", "warning");
      return;
    }
    const rawTarget = String(args[0] ?? "").trim();
    const target = resolveBuiltInToggleKey(rawTarget);
    const customTargetId = rawTarget.toLowerCase();
    const customTarget = (resolved.settings.customStats ?? []).find(stat => stat.id === customTargetId);
    if (!target && !customTarget) {
      notify("用法: /bst toggle <affection|trust|desire|connection|mood|lastThought|自訂統計ID>", "warning");
      return;
    }
    const { context, settings } = resolved;
    let nextSettings = settings;
    let toggledName = "";
    let current = false;
    if (target) {
      current =
        target === "affection" ? settings.trackAffection :
        target === "trust" ? settings.trackTrust :
        target === "desire" ? settings.trackDesire :
        target === "connection" ? settings.trackConnection :
        target === "mood" ? settings.trackMood :
        settings.trackLastThought;
      nextSettings = updateSetting(settings, target, !current);
      toggledName = target;
    } else if (customTarget) {
      current = Boolean(customTarget.track);
      nextSettings = updateCustomTrackSetting(settings, customTarget.id, !current);
      toggledName = customTarget.id;
    }
    deps.setSettings(nextSettings);
    deps.saveSettings(context, nextSettings);
    deps.refreshFromStoredData();
    deps.queuePromptSync(context);
    notify(`已切換 ${toggledName}: ${current ? "關閉" : "開啟"}。`, "success");
  };

  const handleInject = (args: string[]): void => {
    const resolved = withContext();
    if (!resolved) {
      notify("追蹤器尚未就緒。", "warning");
      return;
    }
    const value = (args[0] ?? "").toLowerCase();
    if (value !== "on" && value !== "off") {
      notify("用法: /bst inject on|off", "warning");
      return;
    }
    const { context, settings } = resolved;
    const nextSettings = { ...settings, injectTrackerIntoPrompt: value === "on" };
    deps.setSettings(nextSettings);
    deps.saveSettings(context, nextSettings);
    deps.queuePromptSync(context);
    notify(`Prompt 注入已${value === "on" ? "開啟" : "關閉"}。`, "success");
  };

  const handleDebug = (args: string[]): void => {
    const resolved = withContext();
    if (!resolved) {
      notify("追蹤器尚未就緒。", "warning");
      return;
    }
    const value = (args[0] ?? "").toLowerCase();
    if (value !== "on" && value !== "off") {
      notify("用法: /bst debug on|off", "warning");
      return;
    }
    const { context, settings } = resolved;
    const nextSettings = { ...settings, debug: value === "on" };
    deps.setSettings(nextSettings);
    deps.saveSettings(context, nextSettings);
    notify(`除錯模式已${value === "on" ? "開啟" : "關閉"}。`, "success");
  };

  const handleBst = async (_args: Record<string, unknown>, rawValue: string): Promise<string> => {
    const args = parseArgs(rawValue);
    const sub = (args.shift() ?? "").toLowerCase();
    deps.pushTrace?.("slash", { command: sub || "help" });
    if (!sub || sub === "help") {
      notify(renderHelp());
      return "";
    }
    if (sub === "status") return String(handleStatus() ?? "");
    if (sub === "extract") return String(await handleExtract() ?? "");
    if (sub === "clear") return String(handleClear() ?? "");
    if (sub === "toggle") return String(handleToggle(args) ?? "");
    if (sub === "inject") return String(handleInject(args) ?? "");
    if (sub === "debug") return String(handleDebug(args) ?? "");
    notify(`未知的子命令 "${sub}"。${renderHelp()}`, "warning");
    return "";
  };

    const returns = ARGUMENT_TYPE?.STRING ?? "string";
    const addCommandObject = SlashCommandParser.addCommandObject.bind(SlashCommandParser);
    const fromProps = SlashCommand.fromProps.bind(SlashCommand);
    const add = (name: string, callback: (args: Record<string, unknown>, value: string) => Promise<string> | string, help?: string): void => {
      addCommandObject(fromProps({
        name,
        callback,
        helpString: help,
        returns,
      }));
    };

    add("bst", handleBst, "BetterSimTracker 指令。使用 /bst help 查看說明。");
    add("bst-status", async () => { handleStatus(); return ""; }, "顯示追蹤器狀態。");
    add("bst-extract", async () => { await handleExtract(); return ""; }, "對最新 AI 訊息執行統計提取。");
    add("bst-clear", async () => { handleClear(); return ""; }, "清除目前對話的追蹤資料。");
    add("bst-toggle", async (_args, raw) => { handleToggle(parseArgs(raw)); return ""; }, "切換某項追蹤統計的開關。");
    add("bst-inject", async (_args, raw) => { handleInject(parseArgs(raw)); return ""; }, "切換 Prompt 注入的開關。");
    add("bst-debug", async (_args, raw) => { handleDebug(parseArgs(raw)); return ""; }, "切換除錯模式的開關。");
    return true;
  };

  let attempts = 0;
  const retry = (): void => {
    attempts += 1;
    if (attemptRegister()) {
      if (deps.getSettings()?.debug) {
        notify("Slash 指令已註冊。", "success");
      }
      return;
    }
    if (attempts >= 60) {
      console.warn("[BetterSimTracker] Slash command API not available.");
      return;
    }
    setTimeout(retry, 500);
  };
  retry();
}
