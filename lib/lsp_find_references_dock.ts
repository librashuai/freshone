const lspReferencesDockEditor = getEditor();

interface DockReference {
  file: string;
  relative: string;
  line: number;
  column: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspLocation {
  uri?: string;
  range?: LspRange;
  targetUri?: string;
  targetRange?: LspRange;
  targetSelectionRange?: LspRange;
}

interface ReferencesDockState {
  sourceSplitId: number | null;
  panelBufferId: number | null;
  panelSplitId: number | null;
  references: DockReference[];
  selected: number;
  fileCache: Map<string, string[]>;
  requestToken: number;
  requesting: boolean;
  opening: boolean;
  lastContextClickAt: number;
  lastContextClickIndex: number;
  expandedFileKeys: Set<string>;
  knownFileKeys: Set<string>;
}

const referencesDockState: ReferencesDockState = {
  sourceSplitId: null,
  panelBufferId: null,
  panelSplitId: null,
  references: [],
  selected: 0,
  fileCache: new Map(),
  requestToken: 0,
  requesting: false,
  opening: false,
  lastContextClickAt: 0,
  lastContextClickIndex: -1,
  expandedFileKeys: new Set<string>(),
  knownFileKeys: new Set<string>(),
};

const REFERENCES_DOCK_MODE = "freshone-lsp-references-dock";
const REFERENCES_DOCK_NAME = "LSP References";
const REFERENCES_DOCK_PANEL_KEY = "freshone-lsp-references-dock";
const REFERENCES_DOCK_WIDGET_ID = 73111;
const REFERENCES_LIST_KEY = "lsp-references-list";
const REFERENCES_CONTEXT_KEY = "lsp-references-context";
const REFERENCES_LIST_WIDTH_PCT = 40;
const REFERENCES_CONTEXT_WIDTH_PCT = 60;
const REFERENCES_MUTED: Partial<OverlayOptions> = { fg: "ui.text_muted" };
const REFERENCES_SELECTED_BG = ["editor", "selection_bg"].join(".");
const REFERENCES_MATCH_BG = "search.match_bg";
const REFERENCES_MATCH_FG = "search.match_fg";

function normalizeReferencePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/\/?\?\//, "").replace(/\/$/, "");
}

function comparableReferencePath(path: string): string {
  const normalized = normalizeReferencePath(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function relativeReferencePath(root: string, path: string): string {
  const normalizedRoot = normalizeReferencePath(root);
  const normalizedPath = normalizeReferencePath(path);
  const rootKey = comparableReferencePath(normalizedRoot);
  const pathKey = comparableReferencePath(normalizedPath);
  if (pathKey === rootKey) return lspReferencesDockEditor.pathBasename(normalizedPath);
  if (pathKey.startsWith(`${rootKey}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

function referenceCodePointLength(value: string): number {
  return Array.from(value).length;
}

function readReferenceLines(path: string): string[] {
  const cached = referencesDockState.fileCache.get(path);
  if (cached) return cached;
  let lines: string[] = [];
  try {
    const text = lspReferencesDockEditor.readFile(lspReferencesDockEditor.authorityPath(path));
    if (text !== null) lines = text.replace(/\r\n/g, "\n").split("\n");
  } catch {
    lines = [];
  }
  referencesDockState.fileCache.set(path, lines);
  return lines;
}

function referencesVisibleRows(): number {
  const splitId = referencesDockState.panelSplitId;
  if (splitId === null) return 10;
  const split = lspReferencesDockEditor.listSplits().find((item) => item.splitId === splitId);
  // Toolbar, divider, and section borders consume four rows.
  return Math.max(1, (split?.viewport.height ?? 16) - 4);
}

function truncateReferencePath(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (lspReferencesDockEditor.stringWidth(path) <= maxWidth) return path;
  if (maxWidth <= 3) return ".".repeat(maxWidth);

  const characters = Array.from(path);
  const marker = "...";
  const contentWidth = maxWidth - lspReferencesDockEditor.stringWidth(marker);
  const leadingWidth = Math.ceil(contentWidth / 2);
  const trailingWidth = Math.floor(contentWidth / 2);
  let leading = "";
  let used = 0;
  for (const character of characters) {
    const width = lspReferencesDockEditor.charWidth(character.codePointAt(0) ?? 0);
    if (used + width > leadingWidth) break;
    leading += character;
    used += width;
  }

  let trailing = "";
  used = 0;
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index];
    const width = lspReferencesDockEditor.charWidth(character.codePointAt(0) ?? 0);
    if (used + width > trailingWidth) break;
    trailing = `${character}${trailing}`;
    used += width;
  }
  return `${leading}${marker}${trailing}`;
}

function referencesContextLabel(): string {
  const relative = referencesDockState.references[referencesDockState.selected]?.relative;
  if (!relative) return "Context";
  const split = referencesDockState.panelSplitId === null
    ? undefined
    : lspReferencesDockEditor.listSplits().find(
      (item) => item.splitId === referencesDockState.panelSplitId,
    );
  const sectionWidth = Math.floor(
    (split?.viewport.width ?? 80) * REFERENCES_CONTEXT_WIDTH_PCT / 100,
  );
  const prefix = "Context · ";
  // Leave room for the labeled section's border and surrounding spaces.
  const pathWidth = sectionWidth - lspReferencesDockEditor.stringWidth(prefix) - 4;
  return pathWidth > 0 ? `${prefix}${truncateReferencePath(relative, pathWidth)}` : "Context";
}

interface ReferencesTreeModel {
  nodes: TreeNode[];
  itemKeys: string[];
  referenceByNode: Array<number | null>;
  selectedNodeIndex: number;
}

function referenceFileKey(file: string): string {
  return `file:${file}`;
}

function buildReferencesTree(): ReferencesTreeModel {
  const groups = new Map<string, number[]>();
  for (let index = 0; index < referencesDockState.references.length; index++) {
    const reference = referencesDockState.references[index];
    const indices = groups.get(reference.file);
    if (indices) indices.push(index);
    else groups.set(reference.file, [index]);
  }

  const nodes: TreeNode[] = [];
  const itemKeys: string[] = [];
  const referenceByNode: Array<number | null> = [];
  let selectedNodeIndex = -1;

  for (const [file, referenceIndices] of groups) {
    const fileKey = referenceFileKey(file);
    if (!referencesDockState.knownFileKeys.has(fileKey)) {
      referencesDockState.knownFileKeys.add(fileKey);
      referencesDockState.expandedFileKeys.add(fileKey);
    }
    const filename = lspReferencesDockEditor.pathBasename(file);
    const countText = ` (${referenceIndices.length})`;
    nodes.push({
      text: {
        text: `${filename}${countText}`,
        style: { bold: true },
        properties: { type: "file", file },
        inlineOverlays: [{
          start: filename.length,
          end: filename.length + countText.length,
          unit: "char",
          style: REFERENCES_MUTED,
        }],
      },
      depth: 0,
      hasChildren: true,
    });
    itemKeys.push(fileKey);
    referenceByNode.push(null);

    for (const referenceIndex of referenceIndices) {
      const reference = referencesDockState.references[referenceIndex];
      const nodeIndex = nodes.length;
      const inlineOverlays: InlineOverlay[] = [];
      if (reference.matchEnd > reference.matchStart) {
        inlineOverlays.push({
          start: reference.matchStart,
          end: reference.matchEnd,
          unit: "char",
          style: { fg: REFERENCES_MATCH_FG, bg: REFERENCES_MATCH_BG, bold: true },
        });
      }
      nodes.push({
        text: {
          text: reference.lineText,
          properties: {
            type: "reference",
            file: reference.file,
            line: reference.line,
            column: reference.column,
          },
          inlineOverlays,
        },
        depth: 1,
        hasChildren: false,
        windowAnchor: {
          pinned: 0,
          start: reference.matchStart,
          len: Math.max(1, reference.matchEnd - reference.matchStart),
        },
      });
      itemKeys.push(`reference:${referenceIndex}`);
      referenceByNode.push(referenceIndex);
      if (referenceIndex === referencesDockState.selected) selectedNodeIndex = nodeIndex;
    }
  }

  if (nodes.length === 0) {
    nodes.push({
      text: {
        text: referencesDockState.requesting ? "Finding references…" : "No references",
        style: REFERENCES_MUTED,
      },
      depth: 0,
      hasChildren: false,
    });
    itemKeys.push("lsp-references-empty");
    referenceByNode.push(null);
  }

  return { nodes, itemKeys, referenceByNode, selectedNodeIndex };
}

function referencesContextEntries(): TextPropertyEntry[] {
  const reference = referencesDockState.references[referencesDockState.selected];
  if (!reference) return [{ text: "", style: REFERENCES_MUTED }];
  const lines = readReferenceLines(reference.file);
  if (lines.length === 0) return [{ text: "Unable to read this file", style: REFERENCES_MUTED }];

  const rows = referencesVisibleRows();
  const target = reference.line - 1;
  let start = Math.max(0, target - Math.floor(rows / 2));
  let end = Math.min(lines.length, start + rows);
  start = Math.max(0, end - rows);
  const digits = String(Math.max(1, end)).length;
  const entries: TextPropertyEntry[] = [];

  for (let line = start; line < end; line++) {
    const prefix = `${line === target ? ">" : " "}${String(line + 1).padStart(digits, " ")} │ `;
    const source = lines[line] ?? "";
    const overlays: InlineOverlay[] = [{
      start: 0,
      end: prefix.length,
      unit: "char",
      style: REFERENCES_MUTED,
    }];
    if (line === target && reference.matchEnd > reference.matchStart) {
      overlays.push({
        start: prefix.length + reference.matchStart,
        end: prefix.length + reference.matchEnd,
        unit: "char",
        style: { fg: REFERENCES_MATCH_FG, bg: REFERENCES_MATCH_BG, bold: true },
      });
    }
    entries.push({
      text: `${prefix}${source}`,
      style: line === target ? { bg: REFERENCES_SELECTED_BG, extendToLineEnd: true } : undefined,
      inlineOverlays: overlays,
    });
  }
  return entries;
}

function buildReferencesDockPanel(): WidgetSpec {
  const toolbar: WidgetSpec = {
    kind: "row",
    wrap: false,
    children: [
      { kind: "spacer", cols: 1, flex: false },
      {
        kind: "button",
        label: referencesDockState.requesting
          ? "Finding references…"
          : `LSP References · ${referencesDockState.references.length}`,
        key: "lsp-references-title",
        focused: false,
        intent: "normal",
        disabled: true,
        focusable: false,
        bare: true,
        fullWidth: false,
      },
      { kind: "spacer", cols: 1, flex: true },
      {
        kind: "button",
        label: "×",
        key: "lsp-references-close",
        focused: false,
        intent: "normal",
        disabled: false,
        focusable: true,
        bare: false,
        fullWidth: false,
      },
      { kind: "spacer", cols: 1, flex: false },
    ],
  };

  const tree = buildReferencesTree();
  const contextEntries = referencesContextEntries();
  const columns: WidgetSpec = {
    kind: "row",
    wrap: false,
    children: [
      {
        kind: "labeledSection",
        label: "References",
        widthPct: REFERENCES_LIST_WIDTH_PCT,
        key: "lsp-references-list-section",
        child: {
          kind: "tree",
          nodes: tree.nodes,
          itemKeys: tree.itemKeys,
          selectedIndex: tree.selectedNodeIndex,
          visibleRows: referencesVisibleRows(),
          expandedKeys: [...referencesDockState.expandedFileKeys],
          checkable: false,
          itemHeight: 1,
          cardBorders: false,
          indentCols: 2,
          key: REFERENCES_LIST_KEY,
        },
      },
      {
        kind: "labeledSection",
        label: referencesContextLabel(),
        widthPct: REFERENCES_CONTEXT_WIDTH_PCT,
        key: "lsp-references-context-section",
        child: {
          kind: "list",
          items: contextEntries,
          itemKeys: contextEntries.map((_entry, index) => `reference-context:${index}`),
          selectedIndex: -1,
          visibleRows: referencesVisibleRows(),
          focusable: referencesDockState.references.length > 0,
          key: REFERENCES_CONTEXT_KEY,
        },
      },
    ],
  };

  return {
    kind: "col",
    children: [
      toolbar,
      { kind: "divider", ch: "─", style: REFERENCES_MUTED },
      columns,
    ],
  };
}

function updateReferencesDockPanel(): void {
  if (referencesDockState.panelBufferId === null) return;
  lspReferencesDockEditor.updateWidgetPanel(REFERENCES_DOCK_WIDGET_ID, buildReferencesDockPanel());
  const tree = buildReferencesTree();
  lspReferencesDockEditor.widgetMutate(REFERENCES_DOCK_WIDGET_ID, {
    kind: "setExpandedKeys",
    widgetKey: REFERENCES_LIST_KEY,
    keys: [...referencesDockState.expandedFileKeys],
  });
  if (referencesDockState.references.length > 0) {
    lspReferencesDockEditor.widgetMutate(REFERENCES_DOCK_WIDGET_ID, {
      kind: "setSelectedIndex",
      widgetKey: REFERENCES_LIST_KEY,
      index: tree.selectedNodeIndex,
    });
  }
}

async function collapseReferencesDockIfUnused(
  bufferId: number | null,
  splitId: number | null,
  closeBuffer: boolean,
): Promise<void> {
  if (closeBuffer && bufferId !== null) lspReferencesDockEditor.closeBuffer(bufferId, true);
  if (splitId === null) return;
  await lspReferencesDockEditor.flush();
  const pane = lspReferencesDockEditor.describeWorkspace().panes.find(
    (item) => item.splitId === splitId,
  );
  if (pane?.kind === "file") lspReferencesDockEditor.closeSplit(splitId);
}

function resetReferencesDockState(): void {
  referencesDockState.requestToken++;
  referencesDockState.sourceSplitId = null;
  referencesDockState.panelBufferId = null;
  referencesDockState.panelSplitId = null;
  referencesDockState.references = [];
  referencesDockState.selected = 0;
  referencesDockState.fileCache.clear();
  referencesDockState.requesting = false;
  referencesDockState.opening = false;
  referencesDockState.lastContextClickAt = 0;
  referencesDockState.lastContextClickIndex = -1;
  referencesDockState.expandedFileKeys.clear();
  referencesDockState.knownFileKeys.clear();
}

function closeReferencesDock(): void {
  const sourceSplitId = referencesDockState.sourceSplitId;
  const bufferId = referencesDockState.panelBufferId;
  const splitId = referencesDockState.panelSplitId;
  lspReferencesDockEditor.unmountWidgetPanel(REFERENCES_DOCK_WIDGET_ID);
  resetReferencesDockState();
  void collapseReferencesDockIfUnused(bufferId, splitId, true).catch(() => {});
  if (sourceSplitId !== null) lspReferencesDockEditor.focusSplit(sourceSplitId);
}

async function openReferencesDock(): Promise<void> {
  if (referencesDockState.panelBufferId !== null) {
    updateReferencesDockPanel();
    if (referencesDockState.panelSplitId !== null) {
      lspReferencesDockEditor.focusSplit(referencesDockState.panelSplitId);
    }
    lspReferencesDockEditor.widgetMutate(REFERENCES_DOCK_WIDGET_ID, {
      kind: "setFocusKey",
      widgetKey: REFERENCES_LIST_KEY,
    });
    return;
  }
  if (referencesDockState.opening) return;
  referencesDockState.opening = true;
  try {
    const panel = await lspReferencesDockEditor.createVirtualBufferInSplit({
      name: REFERENCES_DOCK_NAME,
      mode: REFERENCES_DOCK_MODE,
      readOnly: true,
      entries: [],
      direction: "horizontal",
      ratio: 0.65,
      panelId: REFERENCES_DOCK_PANEL_KEY,
      role: "utility_dock",
      editingDisabled: true,
      showLineNumbers: false,
      showCursors: false,
      lineWrap: false,
      scrollable: false,
    });
    referencesDockState.panelBufferId = panel.bufferId;
    referencesDockState.panelSplitId = panel.splitId ?? lspReferencesDockEditor.getActiveSplitId();
    lspReferencesDockEditor.mountWidgetPanel(
      REFERENCES_DOCK_WIDGET_ID,
      panel.bufferId,
      buildReferencesDockPanel(),
      { autoFocusFirst: true },
    );
    lspReferencesDockEditor.widgetMutate(REFERENCES_DOCK_WIDGET_ID, {
      kind: "setFocusKey",
      widgetKey: REFERENCES_LIST_KEY,
    });
  } catch (error) {
    const bufferId = referencesDockState.panelBufferId;
    const splitId = referencesDockState.panelSplitId;
    lspReferencesDockEditor.unmountWidgetPanel(REFERENCES_DOCK_WIDGET_ID);
    resetReferencesDockState();
    void collapseReferencesDockIfUnused(bufferId, splitId, true).catch(() => {});
    throw error;
  } finally {
    referencesDockState.opening = false;
  }
}

function unwrapLspResponse(raw: unknown): unknown {
  let value = raw;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
        continue;
      } catch {
        return value;
      }
    }
    if (value && typeof value === "object" && "result" in value) {
      value = (value as { result: unknown }).result;
      continue;
    }
    break;
  }
  return value;
}

function collectDockReferences(raw: unknown): DockReference[] {
  const value = unwrapLspResponse(raw);
  if (!Array.isArray(value)) return [];
  const root = lspReferencesDockEditor.getCwd();
  const seen = new Set<string>();
  const references: DockReference[] = [];
  referencesDockState.fileCache.clear();

  for (const item of value as LspLocation[]) {
    const uri = item.uri ?? item.targetUri;
    const range = item.range ?? item.targetSelectionRange ?? item.targetRange;
    if (!uri || !range || !range.start) continue;
    const file = lspReferencesDockEditor.fileUriToPath(uri);
    if (!file) continue;
    const line = Math.max(0, range.start.line);
    const column = Math.max(0, range.start.character);
    const key = `${comparableReferencePath(file)}:${line}:${column}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const source = readReferenceLines(file)[line] ?? "";
    const start = referenceCodePointLength(source.slice(0, column));
    const endCharacter = range.end?.line === line
      ? Math.max(column, range.end.character)
      : column;
    const end = referenceCodePointLength(source.slice(0, endCharacter));
    references.push({
      file,
      relative: relativeReferencePath(root, file),
      line: line + 1,
      column: start + 1,
      lineText: source,
      matchStart: start,
      matchEnd: Math.max(start, end),
    });
  }

  references.sort((a, b) =>
    a.relative.localeCompare(b.relative) || a.line - b.line || a.column - b.column
  );
  return references;
}

async function findReferencesDock(): Promise<void> {
  const activeBufferId = lspReferencesDockEditor.getActiveBufferId();
  const info = lspReferencesDockEditor.getBufferInfo(activeBufferId);
  if (!info || !info.path || info.is_virtual || info.is_terminal) {
    lspReferencesDockEditor.setStatus(
      "LSP Find References Dock requires a file-backed source buffer.",
    );
    return;
  }
  const cursor = lspReferencesDockEditor.getPrimaryCursor();
  if (!cursor || cursor.line === null) {
    lspReferencesDockEditor.setStatus("Unable to determine the LSP cursor position.");
    return;
  }
  const uri = lspReferencesDockEditor.pathToFileUri(info.path);
  if (!uri || !info.language) {
    lspReferencesDockEditor.setStatus("Unable to determine the source language or URI.");
    return;
  }

  const sourceSplitId = lspReferencesDockEditor.getActiveSplitId();
  const lineStart = await lspReferencesDockEditor.getLineStartPosition(cursor.line);
  if (lineStart === null) {
    lspReferencesDockEditor.setStatus("Unable to determine the LSP cursor column.");
    return;
  }
  const linePrefix = await lspReferencesDockEditor.getBufferText(
    activeBufferId,
    lineStart,
    cursor.position,
  );

  const token = ++referencesDockState.requestToken;
  referencesDockState.sourceSplitId = sourceSplitId;
  referencesDockState.requesting = true;
  referencesDockState.references = [];
  referencesDockState.selected = 0;
  referencesDockState.lastContextClickAt = 0;
  referencesDockState.lastContextClickIndex = -1;
  referencesDockState.expandedFileKeys.clear();
  referencesDockState.knownFileKeys.clear();
  lspReferencesDockEditor.setStatus("Finding references for Utility Dock…");
  updateReferencesDockPanel();

  try {
    const response = await lspReferencesDockEditor.sendLspRequest(
      info.language,
      "textDocument/references",
      {
        textDocument: { uri },
        position: { line: cursor.line, character: linePrefix.length },
        context: { includeDeclaration: true },
      },
    );
    if (token !== referencesDockState.requestToken) return;
    referencesDockState.requesting = false;
    referencesDockState.references = collectDockReferences(response);
    if (referencesDockState.references.length === 0) {
      updateReferencesDockPanel();
      lspReferencesDockEditor.setStatus("No references found.");
      return;
    }
    await openReferencesDock();
    lspReferencesDockEditor.setStatus(
      `LSP Find References Dock: ${referencesDockState.references.length} reference(s)`,
    );
  } catch (error) {
    if (token !== referencesDockState.requestToken) return;
    referencesDockState.requesting = false;
    updateReferencesDockPanel();
    lspReferencesDockEditor.setStatus(`LSP references request failed: ${String(error)}`);
  }
}

function selectDockReference(index: number): void {
  if (referencesDockState.references.length === 0) return;
  referencesDockState.selected = Math.max(
    0,
    Math.min(index, referencesDockState.references.length - 1),
  );
  referencesDockState.lastContextClickAt = 0;
  referencesDockState.lastContextClickIndex = -1;
  updateReferencesDockPanel();
}

function moveDockReference(delta: number): void {
  const count = referencesDockState.references.length;
  if (count === 0) return;
  referencesDockState.selected = ((referencesDockState.selected + delta) % count + count) % count;
  referencesDockState.lastContextClickAt = 0;
  referencesDockState.lastContextClickIndex = -1;
  updateReferencesDockPanel();
}

function openDockReference(index: number): void {
  const reference = referencesDockState.references[index];
  if (!reference) return;
  let target = referencesDockState.sourceSplitId;
  const workspace = lspReferencesDockEditor.describeWorkspace();
  if (target === null || !workspace.panes.some((pane) => pane.splitId === target && pane.kind === "file")) {
    target = workspace.panes
      .filter((pane) => pane.splitId !== referencesDockState.panelSplitId && pane.kind === "file")
      .sort((a, b) => a.y - b.y || a.x - b.x)[0]?.splitId ?? null;
    referencesDockState.sourceSplitId = target;
  }
  if (target !== null) {
    lspReferencesDockEditor.openFileInSplit(target, reference.file, reference.line, reference.column);
  }
}

function previousDockReference(): void { moveDockReference(-1); }
function nextDockReference(): void { moveDockReference(1); }
function openSelectedDockReference(): void { openDockReference(referencesDockState.selected); }

function onReferencesDockWidgetEvent(data: {
  panel_id: number;
  widget_key: string;
  event_type: string;
  payload: Record<string, unknown>;
}): void {
  if (data.panel_id !== REFERENCES_DOCK_WIDGET_ID) return;
  if (data.event_type === "expand" && data.widget_key === REFERENCES_LIST_KEY) {
    const key = data.payload?.key;
    const expanded = data.payload?.expanded;
    if (typeof key === "string" && typeof expanded === "boolean") {
      if (expanded) referencesDockState.expandedFileKeys.add(key);
      else referencesDockState.expandedFileKeys.delete(key);
      updateReferencesDockPanel();
    }
    return;
  }
  if (data.event_type === "select" && data.widget_key === REFERENCES_LIST_KEY) {
    const nodeIndex = data.payload?.index;
    if (typeof nodeIndex === "number") {
      const tree = buildReferencesTree();
      const referenceIndex = tree.referenceByNode[nodeIndex];
      if (typeof referenceIndex === "number") {
        selectDockReference(referenceIndex);
      } else if (data.payload?.via === "click") {
        const key = tree.itemKeys[nodeIndex];
        if (key?.startsWith("file:")) {
          if (referencesDockState.expandedFileKeys.has(key)) {
            referencesDockState.expandedFileKeys.delete(key);
          } else {
            referencesDockState.expandedFileKeys.add(key);
          }
          updateReferencesDockPanel();
        }
      }
    }
    return;
  }
  if (data.event_type === "select" && data.widget_key === REFERENCES_CONTEXT_KEY) {
    const index = data.payload?.index;
    if (typeof index === "number" && data.payload?.via === "click") {
      const now = Date.now();
      const isDoubleClick =
        index === referencesDockState.lastContextClickIndex &&
        now - referencesDockState.lastContextClickAt <= 500;
      referencesDockState.lastContextClickAt = now;
      referencesDockState.lastContextClickIndex = index;
      if (isDoubleClick) openDockReference(referencesDockState.selected);
    }
    return;
  }
  if (data.event_type !== "activate") return;
  if (data.widget_key === "lsp-references-close") closeReferencesDock();
  if (data.widget_key === REFERENCES_LIST_KEY) openSelectedDockReference();
}

function onReferencesDockBufferClosed(data: { buffer_id: number }): void {
  if (data.buffer_id !== referencesDockState.panelBufferId) return;
  const sourceSplitId = referencesDockState.sourceSplitId;
  const splitId = referencesDockState.panelSplitId;
  lspReferencesDockEditor.unmountWidgetPanel(REFERENCES_DOCK_WIDGET_ID);
  resetReferencesDockState();
  void collapseReferencesDockIfUnused(data.buffer_id, splitId, false).catch(() => {});
  if (sourceSplitId !== null) lspReferencesDockEditor.focusSplit(sourceSplitId);
}

async function onReferencesDockResize(): Promise<void> {
  if (referencesDockState.panelBufferId === null) return;
  await lspReferencesDockEditor.flush();
  if (referencesDockState.panelBufferId !== null) updateReferencesDockPanel();
}

export function registerLspFindReferencesDock(): void {
  registerHandler("freshone_lsp_find_references_dock", findReferencesDock);
  registerHandler("freshone_lsp_references_close", closeReferencesDock);
  registerHandler("freshone_lsp_references_previous", previousDockReference);
  registerHandler("freshone_lsp_references_next", nextDockReference);
  registerHandler("freshone_lsp_references_open", openSelectedDockReference);
  registerHandler("freshone_lsp_references_widget_event", onReferencesDockWidgetEvent);
  registerHandler("freshone_lsp_references_buffer_closed", onReferencesDockBufferClosed);
  registerHandler("freshone_lsp_references_resize", onReferencesDockResize);

  lspReferencesDockEditor.defineMode(
    REFERENCES_DOCK_MODE,
    [
      ["Escape", "freshone_lsp_references_close"],
      ["C-q", "freshone_lsp_references_close"],
      ["Up", "freshone_lsp_references_previous"],
      ["Down", "freshone_lsp_references_next"],
      ["Return", "freshone_lsp_references_open"],
    ],
    true,
    true,
    false,
  );
  lspReferencesDockEditor.on("widget_event", "freshone_lsp_references_widget_event");
  lspReferencesDockEditor.on("buffer_closed", "freshone_lsp_references_buffer_closed");
  lspReferencesDockEditor.on("resize", "freshone_lsp_references_resize");

  lspReferencesDockEditor.registerCommand(
    "LSP Find References Dock",
    "Request references directly from LSP and show them in a custom Utility Dock panel",
    "freshone_lsp_find_references_dock",
    null,
  );
}
