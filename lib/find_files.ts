const fileFinderEditor = getEditor();

interface FileFinderState {
  sourceSplitId: number | null;
  panelBufferId: number | null;
  panelSplitId: number | null;
  query: string;
  paths: string[];
  selected: number;
  status: string;
  searching: boolean;
  truncated: boolean;
  opening: boolean;
  token: number;
  process: ProcessHandle<SpawnResult> | null;
}

const fileFinderState: FileFinderState = {
  sourceSplitId: null, panelBufferId: null, panelSplitId: null,
  query: "", paths: [], selected: -1, status: "Enter a filename regex and press Search",
  searching: false, truncated: false, opening: false, token: 0, process: null,
};
const FILE_FINDER_MODE = "freshone-find-file";
const FILE_FINDER_WIDGET_ID = 73113;
const FILE_FINDER_INPUT = "find-file-input";
const FILE_FINDER_LIST = "find-file-list";
const FILE_FINDER_LIMIT = 10000;
const FILE_FINDER_MUTED: Partial<OverlayOptions> = { fg: "ui.text_muted" };

function fileFinderRows(): number {
  const split = fileFinderEditor.listSplits().find((item) => item.splitId === fileFinderState.panelSplitId);
  // Reserve space for the fixed toolbar and divider; only the list scrolls.
  return Math.max(1, (split?.viewport.height ?? 16) - 3);
}

function fileFinderPanel(): WidgetSpec {
  const state = fileFinderState;
  const input: WidgetSpec = {
    kind: "text", value: state.query, cursorByte: fileFinderEditor.utf8ByteLength(state.query),
    focused: true, label: "Find File", placeholder: "Filename regex", rows: 1,
    fieldWidth: 42, maxVisibleChars: 0, fullWidth: false,
    completions: [], completionsVisibleRows: 0, blockCaret: true,
    selStart: -1, selEnd: -1, labelWidth: 0, readOnly: false, markdown: false,
    key: FILE_FINDER_INPUT,
  };
  const button = (label: string, key: string, disabled = false): WidgetSpec => ({
    kind: "button", label, key, focused: false, intent: "normal", disabled,
    focusable: true, bare: false, fullWidth: false,
  });
  const toolbar: WidgetSpec = {
    kind: "row", wrap: false, children: [
      { kind: "spacer", cols: 1, flex: false }, input,
      { kind: "spacer", cols: 1, flex: true },
      { kind: "raw", entries: [{ text: state.searching ? "Searching…" : state.status,
        style: FILE_FINDER_MUTED }] },
      { kind: "spacer", cols: 1, flex: false },
      button("Search", "find-file-search", state.searching || !state.query),
      button("×", "find-file-close"),
      { kind: "spacer", cols: 1, flex: false },
    ],
  };
  const paths = state.paths;
  const list: WidgetSpec = {
    kind: "list",
    items: paths.length ? paths.map((relative) => ({ text: relative }))
      : [{ text: state.searching ? "Searching…" : state.status, style: FILE_FINDER_MUTED }],
    itemKeys: paths.length ? paths : ["find-file-empty"],
    selectedIndex: paths.length ? state.selected : -1,
    visibleRows: fileFinderRows(), focusable: paths.length > 0, key: FILE_FINDER_LIST,
  };
  return { kind: "col", children: [toolbar, { kind: "divider", ch: "─", style: FILE_FINDER_MUTED }, list] };
}

function updateFileFinder(): void {
  if (fileFinderState.panelBufferId !== null) {
    fileFinderEditor.updateWidgetPanel(FILE_FINDER_WIDGET_ID, fileFinderPanel());
  }
}

function cancelFileFinder(): void {
  fileFinderState.token++;
  if (fileFinderState.process !== null) {
    void fileFinderState.process.kill().catch(() => {});
    fileFinderState.process = null;
  }
  fileFinderState.searching = false;
}

function resetFileFinder(): void {
  cancelFileFinder();
  fileFinderState.sourceSplitId = null;
  fileFinderState.panelBufferId = null;
  fileFinderState.panelSplitId = null;
  fileFinderState.query = "";
  fileFinderState.paths = [];
  fileFinderState.selected = -1;
  fileFinderState.status = "Enter a filename regex and press Search";
  fileFinderState.truncated = false;
  fileFinderState.opening = false;
}

async function collapseFileFinder(bufferId: number | null, splitId: number | null, closeBuffer: boolean): Promise<void> {
  if (closeBuffer && bufferId !== null) fileFinderEditor.closeBuffer(bufferId, true);
  if (splitId === null) return;
  await fileFinderEditor.flush();
  if (fileFinderEditor.describeWorkspace().panes.some((pane) => pane.splitId === splitId && pane.kind === "file")) {
    fileFinderEditor.closeSplit(splitId);
  }
}

function closeFileFinder(): void {
  const { sourceSplitId, panelBufferId, panelSplitId } = fileFinderState;
  fileFinderEditor.unmountWidgetPanel(FILE_FINDER_WIDGET_ID);
  resetFileFinder();
  void collapseFileFinder(panelBufferId, panelSplitId, true).catch(() => {});
  if (sourceSplitId !== null) fileFinderEditor.focusSplit(sourceSplitId);
  fileFinderEditor.setStatus("Find File closed");
}
registerHandler("freshone_find_file_close", closeFileFinder);

function fileFinderRelative(path: string): string {
  // fd returns paths relative to its search root (with ./ or .\\ prefixes).
  return path.replace(/^\.([/\\])/, "").replace(/\\/g, "/");
}

async function searchFiles(): Promise<void> {
  const query = fileFinderState.query;
  if (!query || fileFinderState.panelBufferId === null) return;
  cancelFileFinder();
  const token = fileFinderState.token;
  fileFinderState.searching = true;
  fileFinderState.status = "Searching…";
  fileFinderState.paths = [];
  fileFinderState.selected = -1;
  fileFinderState.truncated = false;
  updateFileFinder();
  try {
    const cwd = fileFinderEditor.getCwd();
    const process = fileFinderEditor.spawnProcess(
      "fd", ["--type", "f", "--color", "never", "--no-require-git", "--print0", "--", query, "."], cwd,
    );
    fileFinderState.process = process;
    const result = await process.result;
    if (token !== fileFinderState.token) return;
    fileFinderState.process = null;
    if (result.exit_code !== 0) {
      throw new Error(result.stderr.trim() || `fd exited with code ${result.exit_code}`);
    }
    // NUL separators preserve spaces and newlines. Parse only up to the
    // display limit rather than allocating an array for every file in a large tree.
    const paths: string[] = [];
    let from = 0;
    while (from < result.stdout.length && paths.length <= FILE_FINDER_LIMIT) {
      const end = result.stdout.indexOf("\0", from);
      const path = result.stdout.slice(from, end < 0 ? undefined : end);
      from = end < 0 ? result.stdout.length : end + 1;
      if (path) paths.push(fileFinderRelative(path));
    }
    fileFinderState.truncated = paths.length > FILE_FINDER_LIMIT;
    fileFinderState.paths = paths.slice(0, FILE_FINDER_LIMIT);
    fileFinderState.selected = fileFinderState.paths.length ? 0 : -1;
    fileFinderState.searching = false;
    fileFinderState.status = fileFinderState.paths.length
      ? `${fileFinderState.truncated ? `${FILE_FINDER_LIMIT}+` : fileFinderState.paths.length} files`
      : "No files found";
    updateFileFinder();
    fileFinderEditor.setStatus(`Find File: ${fileFinderState.status}`);
  } catch (error) {
    if (token !== fileFinderState.token) return;
    fileFinderState.process = null;
    fileFinderState.searching = false;
    fileFinderState.status = `Search failed: ${String(error)}`;
    updateFileFinder();
    fileFinderEditor.setStatus(fileFinderState.status);
  }
}
registerHandler("freshone_find_file_execute", searchFiles);

function openFileFinderResult(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= fileFinderState.paths.length) return;
  const workspace = fileFinderEditor.describeWorkspace();
  let target = fileFinderState.sourceSplitId;
  if (target === null || !workspace.panes.some((pane) => pane.splitId === target && pane.kind === "file")) {
    target = workspace.panes.filter((pane) => pane.kind === "file" && pane.splitId !== fileFinderState.panelSplitId)
      .sort((a, b) => a.y - b.y || a.x - b.x)[0]?.splitId ?? null;
    fileFinderState.sourceSplitId = target;
  }
  if (target !== null) {
    const file = fileFinderEditor.pathJoin(fileFinderEditor.getCwd(), fileFinderState.paths[index]);
    fileFinderEditor.openFileInSplit(target, file, 1, 1);
    // Do not focus the source split or unmount the dock: another row can be clicked.
  }
}

async function startFileFinder(): Promise<void> {
  if (fileFinderState.opening) return;
  if (fileFinderState.panelBufferId !== null) {
    if (fileFinderState.panelSplitId !== null) fileFinderEditor.focusSplit(fileFinderState.panelSplitId);
    fileFinderEditor.widgetMutate(FILE_FINDER_WIDGET_ID, { kind: "setFocusKey", widgetKey: FILE_FINDER_INPUT });
    return;
  }
  fileFinderState.opening = true;
  const activeSplitId = fileFinderEditor.getActiveSplitId();
  const activeBufferId = fileFinderEditor.getActiveBufferId();
  const panes = fileFinderEditor.describeWorkspace().panes;
  const source = panes.find((pane) => pane.splitId === activeSplitId && pane.kind === "file") ??
    panes.filter((pane) => pane.kind === "file").sort((a, b) => a.y - b.y || a.x - b.x)[0];
  const sourceSplitId = source?.splitId ?? activeSplitId;
  fileFinderEditor.setStatus("Checking for fd…");
  try {
    let available = false;
    try {
      available = (await fileFinderEditor.spawnProcess("fd", ["--version"], fileFinderEditor.getCwd()).result).exit_code === 0;
    } catch { /* Missing executable. */ }
    if (!available) {
      const message = "Find File requires fd. Install it from https://github.com/sharkdp/fd";
      fileFinderEditor.setStatus(message);
      fileFinderEditor.showActionPopup({ id: "freshone-find-file-fd-required", title: "fd is not installed",
        message, actions: [{ id: "dismiss", label: "OK" }] });
      return;
    }
    fileFinderState.sourceSplitId = sourceSplitId;
    const cursor = sourceSplitId === activeSplitId ? fileFinderEditor.getPrimaryCursor() : null;
    let initial = "";
    if (cursor?.selection && cursor.selection.end > cursor.selection.start) {
      initial = await fileFinderEditor.getBufferText(source?.bufferId ?? activeBufferId,
        cursor.selection.start, cursor.selection.end);
      if (initial.includes("\n") || initial.includes("\r")) initial = "";
    }
    fileFinderState.query = initial;
    const panel = await fileFinderEditor.createVirtualBufferInSplit({
      name: "Find File", mode: FILE_FINDER_MODE, readOnly: true, entries: [],
      direction: "horizontal", ratio: 0.65, panelId: "freshone-find-file", role: "utility_dock",
      editingDisabled: true, showLineNumbers: false, showCursors: false, lineWrap: false,
      scrollable: false,
    });
    fileFinderState.panelBufferId = panel.bufferId;
    fileFinderState.panelSplitId = panel.splitId ?? fileFinderEditor.getActiveSplitId();
    fileFinderEditor.mountWidgetPanel(FILE_FINDER_WIDGET_ID, panel.bufferId, fileFinderPanel(), { autoFocusFirst: true });
    fileFinderEditor.widgetMutate(FILE_FINDER_WIDGET_ID, { kind: "setFocusKey", widgetKey: FILE_FINDER_INPUT });
  } catch (error) {
    const { panelBufferId, panelSplitId } = fileFinderState;
    fileFinderEditor.unmountWidgetPanel(FILE_FINDER_WIDGET_ID);
    resetFileFinder();
    void collapseFileFinder(panelBufferId, panelSplitId, true).catch(() => {});
    fileFinderEditor.setStatus(`Unable to open Find File: ${String(error)}`);
  } finally {
    fileFinderState.opening = false;
  }
}
registerHandler("freshone_find_file_start", startFileFinder);
fileFinderEditor.registerCommand("Find File", "Find project files by filename regex with fd", "freshone_find_file_start", null);

export function handleFileFinderTextInput(data: { text: string }): boolean {
  if (fileFinderState.panelBufferId === null ||
      fileFinderEditor.getActiveBufferId() !== fileFinderState.panelBufferId || !data?.text) return false;
  fileFinderEditor.widgetCommand(FILE_FINDER_WIDGET_ID, { kind: "textInputChar", text: data.text });
  return true;
}

function fileFinderInputKey(key: string): void {
  fileFinderEditor.widgetCommand(FILE_FINDER_WIDGET_ID, { kind: "textInputKey", key });
}
function fileFinderBackspace(): void { fileFinderInputKey("Backspace"); }
function fileFinderDelete(): void { fileFinderInputKey("Delete"); }
function fileFinderLeft(): void { fileFinderInputKey("Left"); }
function fileFinderRight(): void { fileFinderInputKey("Right"); }
function fileFinderHome(): void { fileFinderInputKey("Home"); }
function fileFinderEnd(): void { fileFinderInputKey("End"); }
function fileFinderTab(): void {
  fileFinderEditor.widgetCommand(FILE_FINDER_WIDGET_ID, { kind: "focusAdvance", delta: 1 });
}
function fileFinderShiftTab(): void {
  fileFinderEditor.widgetCommand(FILE_FINDER_WIDGET_ID, { kind: "focusAdvance", delta: -1 });
}
function fileFinderMove(delta: number): void {
  if (!fileFinderState.paths.length) return;
  fileFinderState.selected = Math.max(0, Math.min(fileFinderState.selected + delta, fileFinderState.paths.length - 1));
  fileFinderEditor.widgetMutate(FILE_FINDER_WIDGET_ID, {
    kind: "setSelectedIndex", widgetKey: FILE_FINDER_LIST, index: fileFinderState.selected,
  });
}
registerHandler("freshone_find_file_backspace", fileFinderBackspace);
registerHandler("freshone_find_file_delete", fileFinderDelete);
registerHandler("freshone_find_file_left", fileFinderLeft);
registerHandler("freshone_find_file_right", fileFinderRight);
registerHandler("freshone_find_file_home", fileFinderHome);
registerHandler("freshone_find_file_end", fileFinderEnd);
registerHandler("freshone_find_file_tab", fileFinderTab);
registerHandler("freshone_find_file_shift_tab", fileFinderShiftTab);
registerHandler("freshone_find_file_previous", () => fileFinderMove(-1));
registerHandler("freshone_find_file_next", () => fileFinderMove(1));
fileFinderEditor.defineMode(FILE_FINDER_MODE, [
  ["Escape", "freshone_find_file_close"], ["C-q", "freshone_find_file_close"],
  ["Return", "freshone_find_file_execute"],
  ["Up", "freshone_find_file_previous"], ["Down", "freshone_find_file_next"],
  ["Tab", "freshone_find_file_tab"], ["S-Tab", "freshone_find_file_shift_tab"],
  ["Backspace", "freshone_find_file_backspace"], ["Delete", "freshone_find_file_delete"],
  ["Left", "freshone_find_file_left"], ["Right", "freshone_find_file_right"],
  ["Home", "freshone_find_file_home"], ["End", "freshone_find_file_end"],
], true, true, false);

function onFileFinderWidgetEvent(event: {
  panel_id: number; widget_key: string; event_type: string;
  payload: Record<string, unknown>;
}): void {
  if (event.panel_id !== FILE_FINDER_WIDGET_ID) return;
  if (event.widget_key === FILE_FINDER_INPUT && event.event_type === "change") {
    const value = event.payload?.value;
    if (typeof value === "string" && value !== fileFinderState.query) {
      cancelFileFinder();
      fileFinderState.query = value;
      fileFinderState.paths = [];
      fileFinderState.selected = -1;
      fileFinderState.truncated = false;
      fileFinderState.status = "Press Search to find files";
      updateFileFinder();
    }
    return;
  }
  if (event.widget_key === FILE_FINDER_LIST && event.event_type === "select") {
    const index = event.payload?.index;
    if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < fileFinderState.paths.length) {
      fileFinderState.selected = index;
      if (event.payload?.via === "click") openFileFinderResult(index);
    }
    return;
  }
  if (event.event_type !== "activate") return;
  if (event.widget_key === "find-file-search") void searchFiles();
  else if (event.widget_key === "find-file-close") closeFileFinder();
  else if (event.widget_key === FILE_FINDER_LIST) {
    openFileFinderResult(typeof event.payload?.index === "number" ? event.payload.index : fileFinderState.selected);
  }
}
registerHandler("freshone_find_file_widget_event", onFileFinderWidgetEvent);
fileFinderEditor.on("widget_event", "freshone_find_file_widget_event");

function onFileFinderBufferClosed(data: { buffer_id: number }): void {
  if (data.buffer_id !== fileFinderState.panelBufferId) return;
  const { sourceSplitId, panelSplitId } = fileFinderState;
  fileFinderEditor.unmountWidgetPanel(FILE_FINDER_WIDGET_ID);
  resetFileFinder();
  void collapseFileFinder(data.buffer_id, panelSplitId, false).catch(() => {});
  if (sourceSplitId !== null) fileFinderEditor.focusSplit(sourceSplitId);
}
registerHandler("freshone_find_file_buffer_closed", onFileFinderBufferClosed);
fileFinderEditor.on("buffer_closed", "freshone_find_file_buffer_closed");

async function onFileFinderResize(): Promise<void> {
  if (fileFinderState.panelBufferId === null) return;
  await fileFinderEditor.flush();
  updateFileFinder();
}
registerHandler("freshone_find_file_resize", onFileFinderResize);
fileFinderEditor.on("resize", "freshone_find_file_resize");
