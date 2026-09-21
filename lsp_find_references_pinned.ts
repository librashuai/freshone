const editor = getEditor();

interface ReferenceLocation {
  file: string;
  line: number;   // Fresh's lsp_references hook uses 1-based locations.
  column: number;
  relative: string;
}

interface ReferencesEvent {
  symbol: string;
  locations: Array<{ file: string; line: number; column: number }>;
}

interface PanelState {
  groupId: number | null;
  listBufferId: number | null;
  contextBufferId: number | null;
  footerBufferId: number | null;
  codeSplitId: number | null;
  panelSplitId: number | null;
  symbol: string;
  root: string;
  references: ReferenceLocation[];
  selected: number;
  rowOffsets: number[];
  fileCache: Map<string, string[]>;
  renderToken: number;
  opening: boolean;
  requestToken: number;
  waiting: boolean;
}

const state: PanelState = {
  groupId: null,
  listBufferId: null,
  contextBufferId: null,
  footerBufferId: null,
  codeSplitId: null,
  panelSplitId: null,
  symbol: "",
  root: "",
  references: [],
  selected: 0,
  rowOffsets: [],
  fileCache: new Map(),
  renderToken: 0,
  opening: false,
  requestToken: 0,
  waiting: false,
};

const MODE = "lsp-find-references-pinned";
const GROUP_LAYOUT = JSON.stringify({
  type: "split",
  direction: "v",
  ratio: 0.95,
  first: {
    type: "split",
    direction: "h", // Buffer-group "h" means side-by-side.
    ratio: 0.38,
    first: { type: "scrollable", id: "files" },
    second: { type: "scrollable", id: "context" },
  },
  second: { type: "fixed", id: "footer", height: 1 },
});

// Build this theme key instead of spelling it as one literal: Fresh 0.5.1's
// standalone script checker mistakes `editor.*` inside strings for API calls.
const SELECTION_BG = ["editor", "selection_bg"].join(".");
const MUTED_STYLE: Partial<OverlayOptions> = { fg: "ui.text_muted" };
const TARGET_STYLE: Partial<OverlayOptions> = {
  bg: SELECTION_BG,
  extendToLineEnd: true,
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "");
}

function displayPath(path: string): string {
  return normalizePath(path).replace(/^\/\/\?\//, "");
}

function comparablePath(path: string): string {
  const normalized = displayPath(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function relativePath(root: string, path: string): string {
  const normalizedRoot = displayPath(root);
  const normalizedPath = displayPath(path);
  const rootKey = comparablePath(normalizedRoot);
  const pathKey = comparablePath(normalizedPath);
  if (pathKey === rootKey) return editor.pathBasename(normalizedPath);
  if (pathKey.startsWith(rootKey + "/")) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

function resetState(): void {
  state.groupId = null;
  state.listBufferId = null;
  state.contextBufferId = null;
  state.footerBufferId = null;
  state.panelSplitId = null;
  state.symbol = "";
  state.references = [];
  state.selected = 0;
  state.rowOffsets = [];
  state.fileCache.clear();
  state.renderToken++;
  state.opening = false;
}

function closePanel(): void {
  const groupId = state.groupId;
  const panelSplitId = state.panelSplitId;
  resetState();
  if (groupId !== null) editor.closeBufferGroup(groupId);
  // The group owns a dedicated bottom split. Closing it restores the exact
  // code layout from before the command instead of leaving an empty pane.
  if (panelSplitId !== null) editor.closeSplit(panelSplitId);
}
registerHandler("frp_close_panel", closePanel);

editor.defineMode(
  MODE,
  [["q", "frp_close_panel"]],
  true,
  false,
  true,
);

function listEntries(): TextPropertyEntry[] {
  state.rowOffsets = [];
  let byteOffset = 0;
  return state.references.map((ref, index) => {
    state.rowOffsets.push(byteOffset);
    const filename = editor.pathBasename(ref.file);
    const suffix = `:${ref.line}`;
    const text = `${filename}${suffix}\n`;
    byteOffset += editor.utf8ByteLength(text);
    return {
      text,
      properties: { referenceIndex: index },
      inlineOverlays: [{
        start: filename.length,
        end: filename.length + suffix.length,
        unit: "char",
        style: MUTED_STYLE,
      }],
    };
  });
}

function setSelected(index: number): void {
  if (state.references.length === 0 || state.listBufferId === null) return;
  const next = Math.max(0, Math.min(index, state.references.length - 1));
  state.selected = next;
  editor.setBufferCursor(state.listBufferId, state.rowOffsets[next] ?? 0);
  renderFooter();
  void renderContext().catch((error) => {
    editor.setStatus(`References context error: ${String(error)}`);
  });
}

function contextHeight(): number {
  // Prefer the dedicated result split. The active viewport may belong to
  // the upper code pane after the user focuses it, and is then much taller.
  if (state.panelSplitId !== null) {
    const panel = editor.listSplits().find((split) => split.splitId === state.panelSplitId);
    if (panel) return Math.max(1, panel.viewport.height);
  }
  const activeViewport = editor.getViewport();
  if (activeViewport && activeViewport.height > 0) return activeViewport.height;
  return 12;
}

function readLines(path: string): string[] {
  const cached = state.fileCache.get(path);
  if (cached) return cached;
  let lines: string[] = [];
  try {
    const text = editor.readFile(editor.authorityPath(path));
    if (text !== null) lines = text.replace(/\r\n/g, "\n").split("\n");
  } catch {
    lines = [];
  }
  state.fileCache.set(path, lines);
  return lines;
}

function renderFooter(): void {
  const bufferId = state.footerBufferId;
  const ref = state.references[state.selected];
  if (bufferId === null || !ref) return;
  editor.setVirtualBufferContent(bufferId, [{
    text: `${ref.relative}\n`,
    style: MUTED_STYLE,
  }]);
}

async function renderContext(): Promise<void> {
  const bufferId = state.contextBufferId;
  const ref = state.references[state.selected];
  if (bufferId === null || !ref) return;

  const mine = ++state.renderToken;
  const lines = readLines(ref.file);
  if (mine !== state.renderToken || bufferId !== state.contextBufferId) return;

  // The footer occupies one row of the result split.
  const visibleCodeRows = Math.max(1, contextHeight() - 1);
  const target = Math.max(0, ref.line - 1);
  let start = Math.max(0, target - Math.floor(visibleCodeRows / 2));
  let end = Math.min(lines.length, start + visibleCodeRows);
  start = Math.max(0, end - visibleCodeRows);

  const entries: TextPropertyEntry[] = [];

  if (lines.length === 0) {
    entries.push({ text: "Unable to read this file.\n", style: MUTED_STYLE });
    editor.setVirtualBufferContent(bufferId, entries);
    return;
  }

  const digits = String(Math.max(1, end)).length;
  // SyntaxRegion.prefix is measured in UTF-8 bytes, not JS characters.
  const prefixLength = editor.utf8ByteLength(` ${"".padStart(digits, " ")} │ `);
  const syntaxStart = 0;
  let syntaxEnd = syntaxStart;

  for (let lineIndex = start; lineIndex < end; lineIndex++) {
    const marker = lineIndex === target ? ">" : " ";
    const prefix = `${marker}${String(lineIndex + 1).padStart(digits, " ")} │ `;
    const text = `${prefix}${lines[lineIndex] ?? ""}\n`;
    syntaxEnd += editor.utf8ByteLength(text);
    entries.push({
      text,
      style: lineIndex === target ? TARGET_STYLE : undefined,
      inlineOverlays: [{
        start: 0,
        end: prefix.length,
        unit: "char",
        style: MUTED_STYLE,
      }],
    });
  }

  editor.setVirtualBufferContent(bufferId, entries);
  editor.setSyntaxRegions(bufferId, [{
    start: syntaxStart,
    end: syntaxEnd,
    language: ref.file,
    prefix: prefixLength,
    streams: [0],
  }]);
}

function renderList(): void {
  if (state.listBufferId === null) return;
  editor.setVirtualBufferContent(state.listBufferId, listEntries());
  editor.setCursorLineOverlay(state.listBufferId, {
    bg: SELECTION_BG,
    extendToLineEnd: true,
  });
  setSelected(state.selected);
}

async function openOrUpdatePanel(): Promise<void> {
  if (state.groupId !== null) {
    state.selected = 0;
    renderList();
    await renderContext();
    return;
  }
  if (state.opening) return;
  state.opening = true;
  try {
    const sourceSplitId = state.codeSplitId ?? editor.getActiveSplitId();
    const created = await editor.splitWindow({
      direction: "horizontal",
      place: "after",
      ratio: 0.65,
    });
    state.codeSplitId = created.sourceSplitId || sourceSplitId;
    state.panelSplitId = created.splitId;

    const group = await editor.createBufferGroup(
      `References: ${state.symbol} (${state.references.length})`,
      MODE,
      GROUP_LAYOUT,
    );
    state.groupId = group.groupId;
    state.listBufferId = group.panels["files"] ?? null;
    state.contextBufferId = group.panels["context"] ?? null;
    state.footerBufferId = group.panels["footer"] ?? null;

    if (
      state.listBufferId === null ||
      state.contextBufferId === null ||
      state.footerBufferId === null
    ) {
      throw new Error("Fresh did not create all reference panels");
    }

    editor.setBufferShowCursors(state.listBufferId, true);
    editor.setBufferShowCursors(state.contextBufferId, false);
    editor.setBufferShowCursors(state.footerBufferId, false);
    editor.focusBufferGroupPanel(state.groupId, "files");
    await editor.flush();
    renderList();
    await renderContext();
  } catch (error) {
    const panelSplitId = state.panelSplitId;
    resetState();
    if (panelSplitId !== null) editor.closeSplit(panelSplitId);
    throw error;
  } finally {
    state.opening = false;
  }
}

async function onReferences(data: ReferencesEvent): Promise<void> {
  state.waiting = false;
  state.requestToken++;
  const activeBuffer = editor.getActiveBufferId();
  if (
    activeBuffer !== state.listBufferId &&
    activeBuffer !== state.contextBufferId &&
    activeBuffer !== state.footerBufferId
  ) {
    // Also support Fresh's built-in Find References menu/keybinding, not just
    // this package's palette command.
    state.codeSplitId = editor.getActiveSplitId();
  }
  if (data.locations.length === 0) {
    editor.setStatus(`No references found for '${data.symbol}'`);
    return;
  }

  const seen = new Set<string>();
  const root = editor.getCwd();
  const refs: ReferenceLocation[] = [];
  for (const item of data.locations) {
    const key = `${comparablePath(item.file)}:${item.line}:${item.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      file: item.file,
      line: item.line,
      column: item.column,
      relative: relativePath(root, item.file),
    });
  }
  refs.sort((a, b) =>
    a.relative.localeCompare(b.relative) || a.line - b.line || a.column - b.column
  );

  state.symbol = data.symbol;
  state.root = root;
  state.references = refs;
  state.selected = 0;
  state.fileCache.clear();
  await openOrUpdatePanel();
  editor.setStatus(`Pinned ${refs.length} reference(s) for '${data.symbol}'`);
}
registerHandler("frp_on_references", onReferences);
editor.on("lsp_references", "frp_on_references");

async function findReferencesPinned(): Promise<void> {
  const activeBuffer = editor.getActiveBufferId();
  if (
    activeBuffer === state.listBufferId ||
    activeBuffer === state.contextBufferId ||
    activeBuffer === state.footerBufferId
  ) {
    editor.setStatus("Run Find References Pinned from a source-code buffer.");
    return;
  }
  const info = editor.getBufferInfo(activeBuffer);
  if (!info || !info.path) {
    editor.setStatus("Find References Pinned requires a file-backed buffer.");
    return;
  }

  state.codeSplitId = editor.getActiveSplitId();
  state.root = editor.getCwd();
  state.waiting = true;
  const token = ++state.requestToken;
  editor.setStatus("Finding references…");
  if (!editor.executeAction("lsp_references")) {
    state.waiting = false;
    editor.setStatus("Unable to start LSP Find References.");
    return;
  }

  // Empty responses do not emit lsp_references in Fresh 0.5.1. Clear the
  // pending marker eventually so a later request is never mistaken for it.
  void editor.delay(15000).then(() => {
    if (state.waiting && state.requestToken === token) state.waiting = false;
  }).catch(() => {});
}
registerHandler("frp_find_references_pinned", findReferencesPinned);
editor.registerCommand(
  "LSP Find References Pinned",
  "Find references and keep a side-by-side result buffer pinned below the code",
  "frp_find_references_pinned",
  null,
);

function openReference(index: number): void {
  const ref = state.references[index];
  if (!ref) return;
  let targetSplit = state.codeSplitId;
  const splits = editor.listSplits();
  if (targetSplit === null || !splits.some((split) => split.splitId === targetSplit)) {
    const candidates = splits
      .filter((split) => split.splitId !== state.panelSplitId)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    targetSplit = candidates[0]?.splitId ?? null;
    state.codeSplitId = targetSplit;
  }
  if (targetSplit === null) return;
  editor.openFileInSplit(targetSplit, ref.file, ref.line, ref.column);
}

function hasOpenModifier(modifiers: string): boolean {
  const value = modifiers.toLowerCase();
  return value.includes("ctrl") || value.includes("control") || value.includes("shift");
}

function onMouseClick(data: MouseClickHookArgs): void {
  if (data.button !== "left" || data.buffer_id === null) return;

  if (data.buffer_id === state.listBufferId && data.buffer_row !== null) {
    const index = Math.max(0, Math.min(data.buffer_row, state.references.length - 1));
    setSelected(index);
    if (hasOpenModifier(data.modifiers)) openReference(index);
    return;
  }

  if (data.buffer_id === state.contextBufferId && data.buffer_row !== null) {
    // Fresh 0.5.1 drops Ctrl from mouse_click.modifiers, so a plain click is
    // retained as a compatibility fallback.
    openReference(state.selected);
  }
}
registerHandler("frp_on_mouse_click", onMouseClick);
editor.on("mouse_click", "frp_on_mouse_click");

function onCursorMoved(data: { buffer_id: number; line: number }): void {
  if (data.buffer_id !== state.listBufferId || data.line === state.selected) return;
  state.selected = Math.max(0, Math.min(data.line, state.references.length - 1));
  renderFooter();
  void renderContext().catch(() => {});
}
registerHandler("frp_on_cursor_moved", onCursorMoved);
editor.on("cursor_moved", "frp_on_cursor_moved");

function onResize(): void {
  if (state.groupId === null) return;
  void renderContext().catch(() => {});
}
registerHandler("frp_on_resize", onResize);
editor.on("resize", "frp_on_resize");

function onBufferClosed(data: { buffer_id: number }): void {
  if (
    data.buffer_id !== state.listBufferId &&
    data.buffer_id !== state.contextBufferId &&
    data.buffer_id !== state.footerBufferId
  ) return;
  const panelSplitId = state.panelSplitId;
  resetState();
  // This path is used by the group's tab close button.
  if (panelSplitId !== null) editor.closeSplit(panelSplitId);
}
registerHandler("frp_on_buffer_closed", onBufferClosed);
editor.on("buffer_closed", "frp_on_buffer_closed");

// Fresh ships a prompt-based find_references plugin. This package replaces
// that presentation, so unload only that renderer after startup; the core
// lsp_references action remains available and emits the hook used above.
async function disableStockReferencesRenderer(): Promise<void> {
  try {
    await editor.unloadPlugin("find_references");
  } catch {
    // Some distributions do not bundle it.
  }
}
registerHandler("frp_disable_stock_references", disableStockReferencesRenderer);
editor.setTimeout(250, "frp_disable_stock_references");
