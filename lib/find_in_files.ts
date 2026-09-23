const findFilesEditor = getEditor();

interface FindFilesMatch {
  file: string;
  relative: string;
  line: number;
  column: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

interface FindFilesState {
  sourceSplitId: number | null;
  panelBufferId: number | null;
  panelSplitId: number | null;
  query: string;
  results: FindFilesMatch[];
  selected: number;
  searching: boolean;
  status: string;
  truncated: boolean;
  token: number;
  opening: boolean;
  rgProcess: ProcessHandle<SpawnResult> | null;
  contextPath: string;
  contextLines: string[];
  lastContextClickAt: number;
  lastContextClickIndex: number;
  expandedFileKeys: Set<string>;
  knownFileKeys: Set<string>;
}

const findFilesState: FindFilesState = {
  sourceSplitId: null,
  panelBufferId: null,
  panelSplitId: null,
  query: "",
  results: [],
  selected: 0,
  searching: false,
  status: "",
  truncated: false,
  token: 0,
  opening: false,
  rgProcess: null,
  contextPath: "",
  contextLines: [],
  lastContextClickAt: 0,
  lastContextClickIndex: -1,
  expandedFileKeys: new Set<string>(),
  knownFileKeys: new Set<string>(),
};

const FIND_FILES_MODE = "freshone-find-in-files";
const FIND_FILES_PANEL_NAME = "Find in Files";
const FIND_FILES_PANEL_KEY = "freshone-find-in-files";
const FIND_FILES_WIDGET_ID = 73110;
const FIND_FILES_INPUT_KEY = "find-files-input";
const FIND_FILES_RESULTS_KEY = "find-files-results";
const FIND_FILES_CONTEXT_KEY = "find-files-context";
const FIND_FILES_MAX_RESULTS = 10000;
const FIND_FILES_MATCHES_WIDTH_PCT = 36;
const FIND_FILES_CONTEXT_WIDTH_PCT = 64;
const FIND_FILES_MUTED: Partial<OverlayOptions> = { fg: "ui.text_muted" };
const FIND_FILES_SELECTED_BG = ["editor", "selection_bg"].join(".");
const FIND_FILES_MATCH_BG = "search.match_bg";
const FIND_FILES_MATCH_FG = "search.match_fg";

function findFilesButton(label: string, key: string, disabled = false): WidgetSpec {
  return {
    kind: "button",
    label,
    key,
    focused: false,
    intent: "normal",
    disabled,
    focusable: true,
    bare: false,
    fullWidth: false,
  };
}

function findFilesInput(value: string): WidgetSpec {
  return {
    kind: "text",
    value,
    cursorByte: findFilesEditor.utf8ByteLength(value),
    focused: true,
    label: "Find in Files",
    placeholder: "Search project file contents",
    rows: 1,
    fieldWidth: 42,
    maxVisibleChars: 0,
    fullWidth: false,
    completions: [],
    completionsVisibleRows: 0,
    blockCaret: true,
    selStart: -1,
    selEnd: -1,
    labelWidth: 0,
    readOnly: false,
    markdown: false,
    key: FIND_FILES_INPUT_KEY,
  };
}

function findFilesProgressText(): string {
  if (!findFilesState.searching && !findFilesState.results.length) return findFilesState.status;
  const count = findFilesState.truncated
    ? `${FIND_FILES_MAX_RESULTS}+ matches`
    : `${findFilesState.results.length} matches`;
  return `${findFilesState.searching ? "Searching… · " : ""}${count}`;
}

function findFilesVisibleRows(): number {
  const splitId = findFilesState.panelSplitId;
  if (splitId === null) return 10;
  const split = findFilesEditor.listSplits().find((item) => item.splitId === splitId);
  // Toolbar, divider, and section borders consume four rows.
  return Math.max(1, (split?.viewport.height ?? 16) - 4);
}

function truncateFindFilesPath(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (findFilesEditor.stringWidth(path) <= maxWidth) return path;
  if (maxWidth <= 3) return ".".repeat(maxWidth);

  const characters = Array.from(path);
  const marker = "...";
  const contentWidth = maxWidth - findFilesEditor.stringWidth(marker);
  const leadingWidth = Math.ceil(contentWidth / 2);
  const trailingWidth = Math.floor(contentWidth / 2);
  let leading = "";
  let used = 0;
  for (const character of characters) {
    const width = findFilesEditor.charWidth(character.codePointAt(0) ?? 0);
    if (used + width > leadingWidth) break;
    leading += character;
    used += width;
  }

  let trailing = "";
  used = 0;
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index];
    const width = findFilesEditor.charWidth(character.codePointAt(0) ?? 0);
    if (used + width > trailingWidth) break;
    trailing = `${character}${trailing}`;
    used += width;
  }
  return `${leading}${marker}${trailing}`;
}

function findFilesContextLabel(): string {
  const relative = findFilesState.results[findFilesState.selected]?.relative;
  if (!relative) return "Context";
  const split = findFilesState.panelSplitId === null
    ? undefined
    : findFilesEditor.listSplits().find((item) => item.splitId === findFilesState.panelSplitId);
  const sectionWidth = Math.floor(
    (split?.viewport.width ?? 80) * FIND_FILES_CONTEXT_WIDTH_PCT / 100,
  );
  const prefix = "Context · ";
  // Leave room for the labeled section's border and surrounding spaces.
  const pathWidth = sectionWidth - findFilesEditor.stringWidth(prefix) - 4;
  return pathWidth > 0 ? `${prefix}${truncateFindFilesPath(relative, pathWidth)}` : "Context";
}

interface FindFilesTreeModel {
  nodes: TreeNode[];
  itemKeys: string[];
  matchByNode: Array<number | null>;
  selectedNodeIndex: number;
}

function findFilesFileKey(file: string): string {
  return `file:${file}`;
}

function buildFindFilesTree(): FindFilesTreeModel {
  const groups = new Map<string, number[]>();
  for (let index = 0; index < findFilesState.results.length; index++) {
    const match = findFilesState.results[index];
    const indices = groups.get(match.file);
    if (indices) indices.push(index);
    else groups.set(match.file, [index]);
  }

  const nodes: TreeNode[] = [];
  const itemKeys: string[] = [];
  const matchByNode: Array<number | null> = [];
  let selectedNodeIndex = -1;

  for (const [file, matchIndices] of groups) {
    const fileKey = findFilesFileKey(file);
    if (!findFilesState.knownFileKeys.has(fileKey)) {
      findFilesState.knownFileKeys.add(fileKey);
      findFilesState.expandedFileKeys.add(fileKey);
    }
    const filename = findFilesEditor.pathBasename(file);
    const countText = ` (${matchIndices.length})`;
    nodes.push({
      text: {
        text: `${filename}${countText}`,
        style: { bold: true },
        properties: { type: "file", file },
        inlineOverlays: [{
          start: filename.length,
          end: filename.length + countText.length,
          unit: "char",
          style: FIND_FILES_MUTED,
        }],
      },
      depth: 0,
      hasChildren: true,
    });
    itemKeys.push(fileKey);
    matchByNode.push(null);

    for (const matchIndex of matchIndices) {
      const match = findFilesState.results[matchIndex];
      const nodeIndex = nodes.length;
      nodes.push({
        text: {
          text: match.lineText,
          properties: {
            type: "match",
            file: match.file,
            line: match.line,
            column: match.column,
          },
          inlineOverlays: [{
            start: match.matchStart,
            end: match.matchEnd,
            unit: "char",
            style: { fg: FIND_FILES_MATCH_FG, bg: FIND_FILES_MATCH_BG, bold: true },
          }],
        },
        depth: 1,
        hasChildren: false,
        windowAnchor: {
          pinned: 0,
          start: match.matchStart,
          len: Math.max(1, match.matchEnd - match.matchStart),
        },
      });
      itemKeys.push(`match:${matchIndex}`);
      matchByNode.push(matchIndex);
      if (matchIndex === findFilesState.selected) selectedNodeIndex = nodeIndex;
    }
  }

  if (nodes.length === 0) {
    nodes.push({
      text: {
        text: findFilesState.searching
          ? "Searching…"
          : findFilesState.status === "No matches" ? "No matches" : "",
        style: FIND_FILES_MUTED,
      },
      depth: 0,
      hasChildren: false,
    });
    itemKeys.push("find-files-empty");
    matchByNode.push(null);
  }

  return { nodes, itemKeys, matchByNode, selectedNodeIndex };
}

function loadFindFilesContext(match: FindFilesMatch | undefined): void {
  if (!match) {
    findFilesState.contextPath = "";
    findFilesState.contextLines = [];
    return;
  }
  if (findFilesState.contextPath === match.file && findFilesState.contextLines.length > 0) return;
  findFilesState.contextPath = match.file;
  try {
    const text = findFilesEditor.readFile(findFilesEditor.authorityPath(match.file));
    findFilesState.contextLines = text === null
      ? []
      : text.replace(/\r\n/g, "\n").split("\n");
  } catch {
    findFilesState.contextLines = [];
  }
}

function findFilesContextEntries(): TextPropertyEntry[] {
  const match = findFilesState.results[findFilesState.selected];
  loadFindFilesContext(match);
  if (!match) return [{ text: "", style: FIND_FILES_MUTED }];
  if (findFilesState.contextLines.length === 0) {
    return [{ text: "Unable to read this file", style: FIND_FILES_MUTED }];
  }

  const rows = findFilesVisibleRows();
  const target = match.line;
  let start = Math.max(0, target - Math.floor(rows / 2));
  let end = Math.min(findFilesState.contextLines.length, start + rows);
  start = Math.max(0, end - rows);
  const digits = String(Math.max(1, end)).length;
  const entries: TextPropertyEntry[] = [];

  for (let line = start; line < end; line++) {
    const prefix = `${line === target ? ">" : " "}${String(line + 1).padStart(digits, " ")} │ `;
    const source = findFilesState.contextLines[line] ?? "";
    const overlays: InlineOverlay[] = [{
      start: 0,
      end: prefix.length,
      unit: "char",
      style: FIND_FILES_MUTED,
    }];
    if (line === target) {
      overlays.push({
        start: prefix.length + match.matchStart,
        end: prefix.length + match.matchEnd,
        unit: "char",
        style: { fg: FIND_FILES_MATCH_FG, bg: FIND_FILES_MATCH_BG, bold: true },
      });
    }
    entries.push({
      text: `${prefix}${source}`,
      style: line === target
        ? { bg: FIND_FILES_SELECTED_BG, extendToLineEnd: true }
        : undefined,
      inlineOverlays: overlays,
    });
  }
  return entries;
}

function buildFindFilesPanel(): WidgetSpec {
  const toolbar: WidgetSpec = {
    kind: "row",
    wrap: false,
    children: [
      { kind: "spacer", cols: 1, flex: false },
      findFilesInput(findFilesState.query),
      { kind: "spacer", cols: 1, flex: false },
      {
        kind: "button",
        label: findFilesProgressText(),
        key: "find-files-progress",
        focused: false,
        intent: "normal",
        disabled: true,
        focusable: false,
        bare: true,
        fullWidth: false,
      },
      { kind: "spacer", cols: 1, flex: true },
      findFilesButton("Search", "find-files-search", findFilesState.searching || !findFilesState.query),
      findFilesButton("×", "find-files-close"),
      { kind: "spacer", cols: 1, flex: false },
    ],
  };

  const tree = buildFindFilesTree();
  const left: WidgetSpec = {
    kind: "tree",
    nodes: tree.nodes,
    itemKeys: tree.itemKeys,
    selectedIndex: tree.selectedNodeIndex,
    // Tree/List auto-height collapses to zero when both are nested side by
    // side in LabeledSections. Pin both columns to the measured body height.
    visibleRows: findFilesVisibleRows(),
    expandedKeys: [...findFilesState.expandedFileKeys],
    checkable: false,
    itemHeight: 1,
    cardBorders: false,
    indentCols: 2,
    key: FIND_FILES_RESULTS_KEY,
  };

  const contextEntries = findFilesContextEntries();
  const contextList: WidgetSpec = {
    kind: "list",
    items: contextEntries,
    itemKeys: contextEntries.map((_entry, index) => `context:${index}`),
    selectedIndex: -1,
    visibleRows: findFilesVisibleRows(),
    focusable: findFilesState.results.length > 0,
    key: FIND_FILES_CONTEXT_KEY,
  };

  const columns: WidgetSpec = {
    kind: "row",
    wrap: false,
    children: [
      {
        kind: "labeledSection",
        label: "Matches",
        child: left,
        widthPct: FIND_FILES_MATCHES_WIDTH_PCT,
        key: "find-files-match-section",
      },
      {
        kind: "labeledSection",
        label: findFilesContextLabel(),
        child: contextList,
        widthPct: FIND_FILES_CONTEXT_WIDTH_PCT,
        key: "find-files-context-section",
      },
    ],
  };

  return {
    kind: "col",
    children: [toolbar, { kind: "divider", ch: "─", style: FIND_FILES_MUTED }, columns],
  };
}

function updateFindFilesPanel(): void {
  if (findFilesState.panelBufferId === null) return;
  findFilesEditor.updateWidgetPanel(FIND_FILES_WIDGET_ID, buildFindFilesPanel());
  const tree = buildFindFilesTree();
  findFilesEditor.widgetMutate(FIND_FILES_WIDGET_ID, {
    kind: "setExpandedKeys",
    widgetKey: FIND_FILES_RESULTS_KEY,
    keys: [...findFilesState.expandedFileKeys],
  });
  if (findFilesState.results.length > 0) {
    findFilesEditor.widgetMutate(FIND_FILES_WIDGET_ID, {
      kind: "setSelectedIndex",
      widgetKey: FIND_FILES_RESULTS_KEY,
      index: tree.selectedNodeIndex,
    });
    findFilesEditor.widgetMutate(FIND_FILES_WIDGET_ID, {
      kind: "setSelectedIndex",
      widgetKey: FIND_FILES_CONTEXT_KEY,
      index: -1,
    });
  }
}

async function collapseFindFilesDockIfUnused(
  bufferId: number | null,
  splitId: number | null,
  closeBuffer: boolean,
): Promise<void> {
  if (closeBuffer && bufferId !== null) findFilesEditor.closeBuffer(bufferId, true);
  if (splitId === null) return;
  await findFilesEditor.flush();
  const pane = findFilesEditor.describeWorkspace().panes.find((item) => item.splitId === splitId);
  if (pane?.kind === "file") findFilesEditor.closeSplit(splitId);
}

function resetFindFilesState(): void {
  findFilesState.token++;
  if (findFilesState.rgProcess !== null) {
    void findFilesState.rgProcess.kill().catch(() => {});
  }
  findFilesState.sourceSplitId = null;
  findFilesState.panelBufferId = null;
  findFilesState.panelSplitId = null;
  findFilesState.query = "";
  findFilesState.results = [];
  findFilesState.selected = 0;
  findFilesState.searching = false;  findFilesState.status = "";
  findFilesState.truncated = false;
  findFilesState.opening = false;
  findFilesState.rgProcess = null;
  findFilesState.contextPath = "";
  findFilesState.contextLines = [];
  findFilesState.lastContextClickAt = 0;
  findFilesState.lastContextClickIndex = -1;
  findFilesState.expandedFileKeys.clear();
  findFilesState.knownFileKeys.clear();
}

function closeFindInFiles(): void {
  const sourceSplitId = findFilesState.sourceSplitId;
  const bufferId = findFilesState.panelBufferId;
  const splitId = findFilesState.panelSplitId;
  findFilesEditor.unmountWidgetPanel(FIND_FILES_WIDGET_ID);
  resetFindFilesState();
  void collapseFindFilesDockIfUnused(bufferId, splitId, true).catch(() => {});
  if (sourceSplitId !== null) findFilesEditor.focusSplit(sourceSplitId);
  findFilesEditor.setStatus("Find in Files closed");
}
registerHandler("freshone_find_files_close", closeFindInFiles);

function findFilesAbsolutePath(cwd: string, path: string): string {
  const clean = path.replace(/^\.([/\\])/, "");
  if (/^[A-Za-z]:[/\\]/.test(clean) || clean.startsWith("/") || clean.startsWith("\\\\")) {
    return clean;
  }
  return findFilesEditor.pathJoin(cwd, clean);
}

// rg's JSON submatch offsets are UTF-8 bytes; Fresh widgets use code points.
function parseFindFilesMatch(line: string, cwd: string): FindFilesMatch[] {
  const event = JSON.parse(line) as {
    type?: string;
    data?: {
      path?: { text?: string };
      lines?: { text?: string };
      line_number?: number;
      submatches?: Array<{ start: number; end: number }>;
    };
  };
  if (event.type !== "match") return [];
  const data = event.data;
  if (typeof data?.path?.text !== "string" || typeof data.lines?.text !== "string" ||
      !Number.isInteger(data.line_number) || (data.line_number ?? 0) < 1 ||
      !Array.isArray(data.submatches)) return [];
  // rg encodes non-UTF-8 paths/lines as base64 bytes, not displayable text.
  const relative = data.path.text.replace(/^\.([/\\])/, "").replace(/\\/g, "/");
  const file = findFilesAbsolutePath(cwd, data.path.text);
  const source = data.lines.text.replace(/\r?\n$/, "");
  const matches: FindFilesMatch[] = [];
  const characters = source[Symbol.iterator]();
  let bytes = 0;
  let column = 0;
  const advance = (offset: number): number | null => {
    while (bytes < offset) {
      const character = characters.next();
      if (character.done) return null;
      bytes += findFilesEditor.utf8ByteLength(character.value);
      column++;
    }
    return bytes === offset ? column : null;
  };
  // rg reports ordered, non-overlapping submatches, so convert all offsets
  // in one pass even on a line with many matches.
  for (const { start, end } of data.submatches) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < bytes || end <= start) continue;
    const matchStart = advance(start);
    const matchEnd = advance(end);
    if (matchStart === null || matchEnd === null || matchStart === matchEnd) continue;
    matches.push({ file, relative, line: data.line_number! - 1, column: matchStart,
      lineText: source, matchStart, matchEnd });
  }
  return matches;
}

async function executeFindInFiles(): Promise<void> {
  const query = findFilesState.query;
  if (!query || findFilesState.panelBufferId === null) return;
  const token = ++findFilesState.token;
  if (findFilesState.rgProcess !== null) {
    void findFilesState.rgProcess.kill().catch(() => {});
    findFilesState.rgProcess = null;
  }
  findFilesState.results = [];
  findFilesState.selected = 0;
  findFilesState.searching = true;
  findFilesState.truncated = false;
  findFilesState.status = "Searching project files with ripgrep…";
  findFilesState.contextPath = "";
  findFilesState.contextLines = [];
  findFilesState.lastContextClickAt = 0;
  findFilesState.lastContextClickIndex = -1;
  findFilesState.expandedFileKeys.clear();
  findFilesState.knownFileKeys.clear();
  updateFindFilesPanel();

  const cwd = findFilesEditor.getCwd();
  try {
    const process = findFilesEditor.spawnProcess(
      "rg",
      ["--json", "--fixed-strings", "--ignore-case", "--no-require-git", "--max-filesize", "10M", "--", query, "."],
      cwd,
    );
    findFilesState.rgProcess = process;
    const result = await process.result;
    if (token !== findFilesState.token) return;
    findFilesState.rgProcess = null;
    // rg: 0 = matches, 1 = no matches, 2 = error.
    if (result.exit_code !== 0 && result.exit_code !== 1) {
      throw new Error(result.stderr.trim() || `rg exited with code ${result.exit_code}`);
    }

    let lastPaint = Date.now();
    let from = 0;
    while (from < result.stdout.length) {
      if (token !== findFilesState.token) return;
      const end = result.stdout.indexOf("\n", from);
      const line = result.stdout.slice(from, end < 0 ? undefined : end);
      from = end < 0 ? result.stdout.length : end + 1;
      if (!line.trim()) continue;
      const matches = parseFindFilesMatch(line, cwd);
      const remaining = FIND_FILES_MAX_RESULTS - findFilesState.results.length;
      if (matches.length > remaining) findFilesState.truncated = true;
      if (remaining > 0) findFilesState.results.push(...matches.slice(0, remaining));
      if (findFilesState.truncated) break;
      const now = Date.now();
      if (now - lastPaint >= 80) {
        updateFindFilesPanel();
        lastPaint = now;
        await findFilesEditor.delay(1);
      }
    }

    if (token !== findFilesState.token) return;
    findFilesState.searching = false;
    findFilesState.status = findFilesState.results.length > 0 ? "Search complete" : "No matches";
    updateFindFilesPanel();
    findFilesEditor.setStatus(
      `Find in Files: ${findFilesState.truncated ? `${FIND_FILES_MAX_RESULTS}+` : findFilesState.results.length} match(es)`,
    );
  } catch (error) {
    if (token !== findFilesState.token) return;
    findFilesState.rgProcess = null;
    findFilesState.searching = false;
    findFilesState.status = `Search failed: ${String(error)}`;
    updateFindFilesPanel();
    findFilesEditor.setStatus(findFilesState.status);
  }
}
registerHandler("freshone_find_files_execute", executeFindInFiles);

function selectFindFilesResult(index: number): void {
  if (findFilesState.results.length === 0) return;
  findFilesState.selected = Math.max(0, Math.min(index, findFilesState.results.length - 1));
  findFilesState.contextPath = "";
  findFilesState.contextLines = [];
  findFilesState.lastContextClickAt = 0;
  findFilesState.lastContextClickIndex = -1;
  updateFindFilesPanel();
}

function moveFindFilesResult(delta: number): void {
  if (findFilesState.results.length === 0) return;
  const count = findFilesState.results.length;
  findFilesState.selected = ((findFilesState.selected + delta) % count + count) % count;
  findFilesState.contextPath = "";
  findFilesState.contextLines = [];
  findFilesState.lastContextClickAt = 0;
  findFilesState.lastContextClickIndex = -1;
  updateFindFilesPanel();
}

function openFindFilesResult(index: number): void {
  const match = findFilesState.results[index];
  if (!match) return;
  let target = findFilesState.sourceSplitId;
  const workspace = findFilesEditor.describeWorkspace();
  if (target === null || !workspace.panes.some((pane) => pane.splitId === target && pane.kind === "file")) {
    target = workspace.panes
      .filter((pane) => pane.splitId !== findFilesState.panelSplitId && pane.kind === "file")
      .sort((a, b) => a.y - b.y || a.x - b.x)[0]?.splitId ?? null;
    findFilesState.sourceSplitId = target;
  }
  if (target !== null) {
    findFilesEditor.openFileInSplit(target, match.file, match.line + 1, match.column + 1);
  }
}

async function startFindInFiles(): Promise<void> {
  if (findFilesState.opening) return;
  if (findFilesState.panelBufferId !== null) {
    if (findFilesState.panelSplitId !== null) findFilesEditor.focusSplit(findFilesState.panelSplitId);
    findFilesEditor.widgetMutate(FIND_FILES_WIDGET_ID, {
      kind: "setFocusKey",
      widgetKey: FIND_FILES_INPUT_KEY,
    });
    return;
  }

  findFilesState.opening = true;
  const activeSplitId = findFilesEditor.getActiveSplitId();
  const activeBufferId = findFilesEditor.getActiveBufferId();
  const workspace = findFilesEditor.describeWorkspace();
  const activePane = workspace.panes.find((pane) => pane.splitId === activeSplitId);
  const sourcePane = activePane?.kind === "file"
    ? activePane
    : workspace.panes
      .filter((pane) => pane.kind === "file")
      .sort((a, b) => a.y - b.y || a.x - b.x)[0];
  const sourceSplitId = sourcePane?.splitId ?? activeSplitId;
  const sourceBufferId = sourcePane?.bufferId ?? activeBufferId;
  findFilesEditor.setStatus("Checking for ripgrep…");
  try {
    let available = false;
    try {
      const check = await findFilesEditor.spawnProcess("rg", ["--version"], findFilesEditor.getCwd()).result;
      available = check.exit_code === 0;
    } catch {
      available = false;
    }
    if (!available) {
      const message = "Find in Files requires ripgrep (rg). Install it from https://github.com/BurntSushi/ripgrep";
      findFilesEditor.setStatus(message);
      findFilesEditor.showActionPopup({
        id: "freshone-rg-required",
        title: "ripgrep is not installed",
        message,
        actions: [{ id: "dismiss", label: "OK" }],
      });
      return;
    }

    findFilesState.sourceSplitId = sourceSplitId;
    const cursor = sourceSplitId === activeSplitId ? findFilesEditor.getPrimaryCursor() : null;
    let initial = "";
    if (cursor?.selection && cursor.selection.end > cursor.selection.start) {
      initial = await findFilesEditor.getBufferText(
        sourceBufferId,
        cursor.selection.start,
        cursor.selection.end,
      );
      if (initial.includes("\n") || initial.includes("\r")) initial = "";
    }
    findFilesState.query = initial;

    const panel = await findFilesEditor.createVirtualBufferInSplit({
      name: FIND_FILES_PANEL_NAME,
      mode: FIND_FILES_MODE,
      readOnly: true,
      entries: [],
      direction: "horizontal",
      ratio: 0.65,
      panelId: FIND_FILES_PANEL_KEY,
      role: "utility_dock",
      editingDisabled: true,
      showLineNumbers: false,
      showCursors: false,
      lineWrap: false,
      scrollable: false,
    });
    findFilesState.panelBufferId = panel.bufferId;
    findFilesState.panelSplitId = panel.splitId ?? findFilesEditor.getActiveSplitId();
    findFilesEditor.mountWidgetPanel(
      FIND_FILES_WIDGET_ID,
      panel.bufferId,
      buildFindFilesPanel(),
      { autoFocusFirst: true },
    );
    findFilesEditor.widgetMutate(FIND_FILES_WIDGET_ID, {
      kind: "setFocusKey",
      widgetKey: FIND_FILES_INPUT_KEY,
    });
  } catch (error) {
    const bufferId = findFilesState.panelBufferId;
    const splitId = findFilesState.panelSplitId;
    findFilesEditor.unmountWidgetPanel(FIND_FILES_WIDGET_ID);
    resetFindFilesState();
    void collapseFindFilesDockIfUnused(bufferId, splitId, true).catch(() => {});
    findFilesEditor.setStatus(`Unable to open Find in Files: ${String(error)}`);
  } finally {
    findFilesState.opening = false;
  }
}
registerHandler("freshone_find_files_start", startFindInFiles);

findFilesEditor.registerCommand(
  "Find in Files",
  "Search project file contents using ripgrep and show results in the Utility Dock",
  "freshone_find_files_start",
  null,
);

export function handleFindFilesTextInput(data: { text: string }): boolean {
  if (
    findFilesState.panelBufferId === null ||
    findFilesEditor.getActiveBufferId() !== findFilesState.panelBufferId ||
    !data?.text
  ) return false;
  findFilesEditor.widgetCommand(FIND_FILES_WIDGET_ID, {
    kind: "textInputChar",
    text: data.text,
  });
  return true;
}

function findFilesInputKey(key: string): void {
  findFilesEditor.widgetCommand(FIND_FILES_WIDGET_ID, { kind: "textInputKey", key });
}
function findFilesBackspace(): void { findFilesInputKey("Backspace"); }
function findFilesDelete(): void { findFilesInputKey("Delete"); }
function findFilesLeft(): void { findFilesInputKey("Left"); }
function findFilesRight(): void { findFilesInputKey("Right"); }
function findFilesHome(): void { findFilesInputKey("Home"); }
function findFilesEnd(): void { findFilesInputKey("End"); }
function findFilesTab(): void {
  findFilesEditor.widgetCommand(FIND_FILES_WIDGET_ID, { kind: "focusAdvance", delta: 1 });
}
function findFilesShiftTab(): void {
  findFilesEditor.widgetCommand(FIND_FILES_WIDGET_ID, { kind: "focusAdvance", delta: -1 });
}
function findFilesPrevious(): void { moveFindFilesResult(-1); }
function findFilesNext(): void { moveFindFilesResult(1); }
registerHandler("freshone_find_files_backspace", findFilesBackspace);
registerHandler("freshone_find_files_delete", findFilesDelete);
registerHandler("freshone_find_files_left", findFilesLeft);
registerHandler("freshone_find_files_right", findFilesRight);
registerHandler("freshone_find_files_home", findFilesHome);
registerHandler("freshone_find_files_end", findFilesEnd);
registerHandler("freshone_find_files_tab", findFilesTab);
registerHandler("freshone_find_files_shift_tab", findFilesShiftTab);
registerHandler("freshone_find_files_previous", findFilesPrevious);
registerHandler("freshone_find_files_next", findFilesNext);

findFilesEditor.defineMode(
  FIND_FILES_MODE,
  [
    ["Escape", "freshone_find_files_close"],
    ["C-q", "freshone_find_files_close"],
    ["Return", "freshone_find_files_execute"],
    ["Up", "freshone_find_files_previous"],
    ["Down", "freshone_find_files_next"],
    ["Tab", "freshone_find_files_tab"],
    ["S-Tab", "freshone_find_files_shift_tab"],
    ["Backspace", "freshone_find_files_backspace"],
    ["Delete", "freshone_find_files_delete"],
    ["Left", "freshone_find_files_left"],
    ["Right", "freshone_find_files_right"],
    ["Home", "freshone_find_files_home"],
    ["End", "freshone_find_files_end"],
  ],
  true,
  true,
  false,
);

function onFindFilesWidgetEvent(data: {
  panel_id: number;
  widget_key: string;
  event_type: string;
  payload: Record<string, unknown>;
}): void {
  if (data.panel_id !== FIND_FILES_WIDGET_ID) return;
  if (data.event_type === "change" && data.widget_key === FIND_FILES_INPUT_KEY) {
    const value = data.payload?.value;
    if (typeof value === "string") {
      findFilesState.query = value;
      findFilesState.lastContextClickAt = 0;
      findFilesState.lastContextClickIndex = -1;
      if (findFilesState.searching) {
        findFilesState.token++;
        if (findFilesState.rgProcess !== null) {
          void findFilesState.rgProcess.kill().catch(() => {});
          findFilesState.rgProcess = null;
        }
        findFilesState.searching = false;
        findFilesState.status = "Search cancelled; press Search";
      }
      updateFindFilesPanel();
    }
    return;
  }
  if (data.event_type === "expand" && data.widget_key === FIND_FILES_RESULTS_KEY) {
    const key = data.payload?.key;
    const expanded = data.payload?.expanded;
    if (typeof key === "string" && typeof expanded === "boolean") {
      if (expanded) findFilesState.expandedFileKeys.add(key);
      else findFilesState.expandedFileKeys.delete(key);
      // Fresh 0.5.1's described Tree paints expansion from the spec rather
      // than its mutated instance state, so re-emit the spec immediately.
      updateFindFilesPanel();
    }
    return;
  }
  if (data.event_type === "select" && data.widget_key === FIND_FILES_RESULTS_KEY) {
    const nodeIndex = data.payload?.index;
    if (typeof nodeIndex === "number") {
      const tree = buildFindFilesTree();
      const matchIndex = tree.matchByNode[nodeIndex];
      if (typeof matchIndex === "number") {
        selectFindFilesResult(matchIndex);
      } else if (data.payload?.via === "click") {
        // Clicking anywhere on a file row toggles it; the disclosure arrow
        // continues to work through the Tree's native `expand` event too.
        const key = tree.itemKeys[nodeIndex];
        if (key?.startsWith("file:")) {
          if (findFilesState.expandedFileKeys.has(key)) {
            findFilesState.expandedFileKeys.delete(key);
          } else {
            findFilesState.expandedFileKeys.add(key);
          }
          updateFindFilesPanel();
        }
      }
    }
    return;
  }
  if (data.event_type === "select" && data.widget_key === FIND_FILES_CONTEXT_KEY) {
    const index = data.payload?.index;
    if (typeof index === "number" && data.payload?.via === "click") {
      const now = Date.now();
      const isDoubleClick =
        index === findFilesState.lastContextClickIndex &&
        now - findFilesState.lastContextClickAt <= 500;
      findFilesState.lastContextClickAt = now;
      findFilesState.lastContextClickIndex = index;
      if (isDoubleClick) {
        findFilesState.lastContextClickAt = 0;
        findFilesState.lastContextClickIndex = -1;
        openFindFilesResult(findFilesState.selected);
      }
    }
    return;
  }
  if (data.event_type !== "activate") return;
  switch (data.widget_key) {
    case "find-files-search":
      void executeFindInFiles().catch(() => {});
      break;
    case "find-files-close":
      closeFindInFiles();
      break;
  }
}
registerHandler("freshone_find_files_widget_event", onFindFilesWidgetEvent);
findFilesEditor.on("widget_event", "freshone_find_files_widget_event");

function onFindFilesBufferClosed(data: { buffer_id: number }): void {
  if (data.buffer_id !== findFilesState.panelBufferId) return;
  const sourceSplitId = findFilesState.sourceSplitId;
  const splitId = findFilesState.panelSplitId;
  findFilesEditor.unmountWidgetPanel(FIND_FILES_WIDGET_ID);
  resetFindFilesState();
  void collapseFindFilesDockIfUnused(data.buffer_id, splitId, false).catch(() => {});
  if (sourceSplitId !== null) findFilesEditor.focusSplit(sourceSplitId);
}
registerHandler("freshone_find_files_buffer_closed", onFindFilesBufferClosed);
findFilesEditor.on("buffer_closed", "freshone_find_files_buffer_closed");

async function onFindFilesResize(): Promise<void> {
  if (findFilesState.panelBufferId === null) return;
  // The resize hook can run before listSplits() receives the divider's new
  // viewport. Flush first so visibleRows is derived from the current dock.
  await findFilesEditor.flush();
  if (findFilesState.panelBufferId !== null) updateFindFilesPanel();
}
registerHandler("freshone_find_files_resize", onFindFilesResize);
findFilesEditor.on("resize", "freshone_find_files_resize");
