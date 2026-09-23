const piSessionsEditor = getEditor();
const PI_SESSIONS_PANEL = 73112;
const PI_SESSIONS_LIST = "freshone-pi-sessions-list";

interface PiSessionItem {
  path: string;
  label: string;
}

const piSessionsState = {
  cwd: "",
  root: "",
  directory: "",
  sessions: [] as PiSessionItem[],
  selectedPath: "",
  scanError: "",
  filesFound: 0,
  mounted: false,
  rootWatch: null as number | null,
  directoryWatch: null as number | null,
  generation: 0,
  refreshTimer: null as number | null,
  watching: false,
  opening: false,
};

function piCleanPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/\/\?\//, "");
  return normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)
    ? normalized : normalized.replace(/\/+$/, "");
}

function piComparablePath(path: string): string {
  const normalized = piCleanPath(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function piJoin(...parts: string[]): string {
  return parts.reduce((base, part, index) => index === 0 ? piCleanPath(part)
    : `${base.replace(/\/+$/, "")}/${piCleanPath(part).replace(/^\/+/, "")}`, "");
}

function piAgentDirectory(): string {
  const home = piSessionsEditor.getEnv("USERPROFILE") || piSessionsEditor.getEnv("HOME");
  return piSessionsEditor.getEnv("PI_CODING_AGENT_DIR") ||
    (home ? piJoin(home, ".pi", "agent") : "");
}

function piCustomSessionDirectory(cwd: string): string | null {
  const agentDir = piAgentDirectory();
  const override = piSessionsEditor.getEnv("PI_CODING_AGENT_SESSION_DIR");
  let configured = override;
  if (!configured && agentDir) {
    try {
      const settings = piSessionsEditor.readFile(piSessionsEditor.localPath(
        piJoin(agentDir, "settings.json"),
      ));
      const parsed = settings ? JSON.parse(settings) as { sessionDir?: unknown } : null;
      if (typeof parsed?.sessionDir === "string" && parsed.sessionDir) configured = parsed.sessionDir;
    } catch { /* Use pi's default. */ }
  }
  if (!configured) return null;
  // Pi resolves relative sessionDir values against the working directory.
  return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(configured)
    ? configured
    : piJoin(cwd, configured);
}

function piSessionRoot(): string {
  const agentDir = piAgentDirectory();
  return agentDir ? piJoin(agentDir, "sessions") : "";
}

function piProjectDirectory(root: string, cwd: string): string {
  // Pi's session-manager encodes the absolute cwd, not the project basename.
  const encoded = piCleanPath(cwd).replace(/^\/+/, "").replace(/[/:]/g, "-");
  return piJoin(root, `--${encoded}--`);
}

function piSessionLabel(path: string, text: string): string | null {
  const newline = text.indexOf("\n");
  try {
    const header = JSON.parse(text.slice(0, newline < 0 ? undefined : newline)) as {
      type?: string; cwd?: string; id?: string;
    };
    if (header.type !== "session" || typeof header.cwd !== "string" ||
        piComparablePath(header.cwd) !== piComparablePath(piSessionsState.cwd)) return null;
    let name = "";
    let firstMessage = "";
    // Names are append-only metadata; the last session_info wins (including an empty name).
    for (const line of text.split("\n").slice(1)) {
      if (!line.includes('"session_info"') && !(firstMessage === "" && line.includes('"message"'))) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string; name?: string; message?: { role?: string; content?: unknown };
        };
        if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
        if (entry.type === "message" && entry.message?.role === "user" && !firstMessage) {
          const content = entry.message.content;
          firstMessage = typeof content === "string" ? content
            : Array.isArray(content) ? content.find((part) => part?.type === "text")?.text ?? "" : "";
        }
      } catch { /* A live session may have a partially written final line. */ }
    }
    return (name || firstMessage || header.id || path.replace(/^.*[\\/]/, "")
      .replace(/\.jsonl$/, "").replace(/^[^_]+_/, ""))
      .replace(/\s+/g, " ").trim().slice(0, 100);
  } catch { return null; }
}

function piSessionsPanel(): WidgetSpec {
  const items: TextPropertyEntry[] = piSessionsState.sessions.length
    ? piSessionsState.sessions.map((item) => ({ text: item.label }))
    : [{ text: piSessionsState.scanError || (piSessionsState.root
      ? "No pi sessions for this project" : "Pi home not found"), style: { fg: "ui.text_muted" } }];
  return {
    kind: "col",
    children: [{
      kind: "list", items,
      itemKeys: piSessionsState.sessions.length
        ? piSessionsState.sessions.map((item) => item.path) : ["pi-sessions-empty"],
      selectedIndex: piSessionsState.sessions.findIndex((item) => item.path === piSessionsState.selectedPath),
      visibleRows: 7,
      focusable: true, key: PI_SESSIONS_LIST,
    }],
  };
}

function piUpdatePanel(): void {
  if (!piSessionsState.mounted) return;
  piSessionsEditor.updateFloatingWidget(PI_SESSIONS_PANEL, piSessionsPanel());
  const index = piSessionsState.sessions.findIndex((item) => item.path === piSessionsState.selectedPath);
  if (index >= 0) piSessionsEditor.widgetMutate(PI_SESSIONS_PANEL, {
    kind: "setSelectedIndex", widgetKey: PI_SESSIONS_LIST, index,
  });
}

function piScanSessions(): void {
  const items: PiSessionItem[] = [];
  piSessionsState.scanError = "";
  piSessionsState.filesFound = 0;
  if (piSessionsState.directory) {
    try {
      const files = piSessionsEditor.readDir(piSessionsEditor.localPath(piSessionsState.directory))
        .filter((entry) => !entry.is_dir && entry.name.endsWith(".jsonl"))
        .sort((a, b) => b.name.localeCompare(a.name));
      piSessionsState.filesFound = files.length;
      for (const entry of files) {
        const path = piJoin(piSessionsState.directory, entry.name);
        try {
          const text = piSessionsEditor.readFile(piSessionsEditor.localPath(path));
          if (text === null) continue;
          const label = piSessionLabel(path, text);
          if (label !== null) items.push({ path, label });
        } catch { /* Deleted during scan. */ }
      }
    } catch (error) {
      if (!piSessionsState.scanError) piSessionsState.scanError = `Unable to scan Pi sessions: ${String(error)}`;
    }
  }
  piSessionsState.sessions = items;
  if (!items.some((item) => item.path === piSessionsState.selectedPath)) {
    piSessionsState.selectedPath = items[0]?.path ?? "";
  }
  piUpdatePanel();
}

function piStopWatches(): void {
  piSessionsState.generation++;
  for (const handle of [piSessionsState.rootWatch, piSessionsState.directoryWatch]) {
    if (handle !== null) piSessionsEditor.unwatchPath(handle);
  }
  piSessionsState.rootWatch = null;
  piSessionsState.directoryWatch = null;
  piSessionsState.watching = false;
}

async function piWatchDirectories(): Promise<void> {
  if (piSessionsState.watching || !piSessionsState.root) return;
  piSessionsState.watching = true;
  const generation = piSessionsState.generation;
  try {
    for (const [field, path] of [
      ["rootWatch", piSessionsState.root], ["directoryWatch", piSessionsState.directory],
    ] as const) {
      if (field === "directoryWatch" && path === piSessionsState.root) continue;
      // fileExists may only test regular files; let watchPath validate directories.
      if (piSessionsState[field] !== null) continue;
      try {
        const handle = await piSessionsEditor.watchPath(path);
        if (generation !== piSessionsState.generation) piSessionsEditor.unwatchPath(handle);
        else piSessionsState[field] = handle;
      } catch { /* Retry when the directory is created or at the next health check. */ }
    }
  } finally {
    if (generation === piSessionsState.generation) piSessionsState.watching = false;
  }
}

function piSyncWorkspace(): void {
  const cwd = piSessionsEditor.getCwd();
  const custom = piCustomSessionDirectory(cwd);
  const root = custom ?? piSessionRoot();
  const directory = custom ?? (root ? piProjectDirectory(root, cwd) : "");
  if (cwd === piSessionsState.cwd && root === piSessionsState.root &&
      directory === piSessionsState.directory) return;
  piStopWatches();
  if (piSessionsState.refreshTimer !== null) piSessionsEditor.clearInterval(piSessionsState.refreshTimer);
  piSessionsState.refreshTimer = null;
  piSessionsState.cwd = cwd;
  piSessionsState.root = root;
  piSessionsState.directory = directory;
  piSessionsState.selectedPath = "";
  piScanSessions();
  void piWatchDirectories();
}

function piRefresh(): void {
  if (piSessionsState.refreshTimer !== null) piSessionsEditor.clearInterval(piSessionsState.refreshTimer);
  piSessionsState.refreshTimer = null;
  piSyncWorkspace();
  piScanSessions();
  void piWatchDirectories();
}

function piOnPathChanged(event: { handle: number; path: string; kind: string }): void {
  if (event.handle !== piSessionsState.rootWatch && event.handle !== piSessionsState.directoryWatch) return;
  // Pi appends on every turn; don't reread every (potentially large) conversation
  // on each write. Still retry incomplete headers of newly created files.
  if (event.kind === "modify" && piSessionsState.sessions.some(
    (item) => piComparablePath(item.path) === piComparablePath(event.path),
  )) return;
  if (event.handle === piSessionsState.rootWatch && piSessionsState.root !== piSessionsState.directory &&
      (event.kind === "create" || event.kind === "delete" || event.kind === "rename")) {
    if (piSessionsState.directoryWatch !== null) piSessionsEditor.unwatchPath(piSessionsState.directoryWatch);
    piSessionsState.directoryWatch = null;
  }
  if (piSessionsState.refreshTimer !== null) piSessionsEditor.clearInterval(piSessionsState.refreshTimer);
  piSessionsState.refreshTimer = piSessionsEditor.setTimeout(200, "freshone_pi_sessions_refresh");
}

function piHealthCheck(): void {
  piSyncWorkspace();
  // The parent watch observes creation/removal of the project directory.
  // Do not use fileExists on directories: some Fresh backends return false.
  if (piSessionsState.rootWatch === null ||
      (piSessionsState.root !== piSessionsState.directory && piSessionsState.directoryWatch === null)) {
    piScanSessions();
    void piWatchDirectories();
  }
}

async function piResumeSelected(): Promise<void> {
  piSyncWorkspace();
  const session = piSessionsState.sessions.find((item) => item.path === piSessionsState.selectedPath);
  if (!session || piSessionsState.opening) return;
  // Never resume a file that was removed between the scan and the keystroke.
  if (!piSessionsEditor.fileExists(piSessionsEditor.localPath(session.path))) {
    piRefresh();
    return;
  }
  piSessionsState.opening = true;
  try {
    // `pi -r` opens an interactive picker; `--session` resumes this exact file.
    // Pass argv directly: session paths can contain spaces and shell metacharacters.
    const command = piSessionsEditor.getEnv("OS") === "Windows_NT" ? "pi.cmd" : "pi";
    await piSessionsEditor.createTerminal({
      cwd: piSessionsState.cwd, direction: "horizontal", focus: true,
      command: [command, "--session", session.path],
      resume: [command, "--session", session.path],
      title: "pi session",
    });
  } catch (error) {
    piSessionsEditor.setStatus(`Unable to resume pi session: ${String(error)}`);
  } finally {
    piSessionsState.opening = false;
  }
}

function piOnWidgetEvent(event: {
  panel_id: number; widget_key: string; event_type: string;
  payload: Record<string, unknown>;
}): void {
  if (event.panel_id !== PI_SESSIONS_PANEL) return;
  if (event.event_type === "cancel") {
    piSessionsState.mounted = false;
    piSessionsEditor.unmountFloatingWidget(PI_SESSIONS_PANEL);
    return;
  }
  if (event.widget_key !== PI_SESSIONS_LIST) return;
  if (event.event_type === "select" && typeof event.payload?.index === "number") {
    const item = piSessionsState.sessions[event.payload.index];
    if (item) piSessionsState.selectedPath = item.path;
  } else if (event.event_type === "activate") {
    // The list's built-in Enter key (and double-click) activates the selected row.
    void piResumeSelected();
  }
}

function piSessionsStatus(): void {
  piSyncWorkspace();
  const details = `cwd=${piSessionsState.cwd} · dir=${piSessionsState.directory} · ${piSessionsState.scanError || "OK"}`;
  piSessionsEditor.info(`Pi sessions: ${piSessionsState.sessions.length}/${piSessionsState.filesFound} JSONL · ${details}`);
  piSessionsEditor.setStatus(`Pi sessions: ${piSessionsState.sessions.length}/${piSessionsState.filesFound} JSONL · ${details}`);
}

function piShowSessions(): void {
  piSyncWorkspace();
  if (!piSessionsState.mounted) {
    piSessionsState.mounted = piSessionsEditor.mountSidebarSection(
      PI_SESSIONS_PANEL, piSessionsPanel(), "Pi Sessions", 8,
      { closable: true, startBlurred: true },
    );
  }
  piRefresh();
  piSessionsEditor.floatingPanelControl(PI_SESSIONS_PANEL, "focus", 0);
  piSessionsEditor.widgetMutate(PI_SESSIONS_PANEL, { kind: "setFocusKey", widgetKey: PI_SESSIONS_LIST });
}

export function registerPiSessions(): void {
  registerHandler("freshone_pi_sessions_show", piShowSessions);
  registerHandler("freshone_pi_sessions_resume", piResumeSelected);
  registerHandler("freshone_pi_sessions_refresh", piRefresh);
  registerHandler("freshone_pi_sessions_status", piSessionsStatus);
  registerHandler("freshone_pi_sessions_health", piHealthCheck);
  registerHandler("freshone_pi_sessions_path_changed", piOnPathChanged);
  registerHandler("freshone_pi_sessions_window_changed", piSyncWorkspace);
  registerHandler("freshone_pi_sessions_widget_event", piOnWidgetEvent);
  piSessionsEditor.on("path_changed", "freshone_pi_sessions_path_changed");
  piSessionsEditor.on("active_window_changed", "freshone_pi_sessions_window_changed");
  piSessionsEditor.on("widget_event", "freshone_pi_sessions_widget_event");
  piSessionsEditor.registerCommand("Pi Focus Sessions", "Focus the Pi Sessions section in the file explorer", "freshone_pi_sessions_show");
  piSessionsEditor.registerCommand("Pi Resume Session", "Open the selected session in a new terminal split", "freshone_pi_sessions_resume");
  piSessionsEditor.registerCommand("Pi Refresh Sessions", "Rescan Pi sessions for this project", "freshone_pi_sessions_refresh");
  piSessionsEditor.registerCommand("Pi Sessions Status", "Show the Pi session directory and scan result", "freshone_pi_sessions_status");
  piSyncWorkspace();
  piSessionsState.mounted = piSessionsEditor.mountSidebarSection(
    PI_SESSIONS_PANEL, piSessionsPanel(), "Pi Sessions", 8,
    { closable: true, startBlurred: true },
  );
  piSessionsEditor.setInterval(3000, "freshone_pi_sessions_health");
}
