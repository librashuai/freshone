const bufferSearchEditor = getEditor();

interface BufferSearchMatch {
  start: number;
  end: number;
  line: number;
  lineText: string;
  lineMatchStart: number;
  lineMatchEnd: number;
}

interface BufferSearchState {
  sourceBufferId: number | null;
  sourceSplitId: number | null;
  panelBufferId: number | null;
  panelSplitId: number | null;
  query: string;
  matches: BufferSearchMatch[];
  selected: number;
  showResults: boolean;
  anchorPosition: number;
  opening: boolean;
  searchToken: number;
  editTimer: number | null;
}

const bufferSearchState: BufferSearchState = {
  sourceBufferId: null,
  sourceSplitId: null,
  panelBufferId: null,
  panelSplitId: null,
  query: "",
  matches: [],
  selected: 0,
  showResults: false,
  anchorPosition: 0,
  opening: false,
  searchToken: 0,
  editTimer: null,
};

const BUFFER_SEARCH_MODE = "freshone-buffer-search-bar";
const BUFFER_SEARCH_PANEL_NAME = "Find in Buffer";
const BUFFER_SEARCH_WIDGET_ID = 73109;
const SEARCH_INPUT_KEY = "buffer-search-input";
const RESULTS_LIST_KEY = "buffer-search-results";
const MATCH_NAMESPACE = "freshone-buffer-search-matches";
const CURRENT_NAMESPACE = "freshone-buffer-search-current";
const SEARCH_MATCH_BG = "search.match_bg";
const SEARCH_MATCH_FG = "search.match_fg";
// Fresh 0.5.1's standalone checker mistakes `editor.*` inside a literal for
// an API call, so construct this theme key instead.
const CURRENT_MATCH_BG = ["editor", "selection_bg"].join(".");
const MUTED: Partial<OverlayOptions> = { fg: "ui.text_muted" };

function searchButton(
  label: string,
  key: string,
  disabled = false,
  bare = false,
): WidgetSpec {
  const result: WidgetSpec = {
    kind: "button",
    label,
    key,
    focused: false,
    intent: "normal",
    disabled,
    focusable: true,
    bare,
    fullWidth: false,
  };
  if (bare) result.hoverStyle = { fg: "ui.tab_close_hover_fg" };
  return result;
}

function searchInput(value: string): WidgetSpec {
  return {
    kind: "text",
    value,
    cursorByte: bufferSearchEditor.utf8ByteLength(value),
    focused: true,
    label: "Find",
    placeholder: "Search current buffer",
    rows: 1,
    fieldWidth: 36,
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
    key: SEARCH_INPUT_KEY,
  };
}

function resultEntries(): TextPropertyEntry[] {
  const lastLine = bufferSearchState.matches.reduce(
    (maximum, match) => Math.max(maximum, match.line + 1),
    1,
  );
  const digits = String(lastLine).length;
  return bufferSearchState.matches.map((match, index) => {
    const lineNumber = String(match.line + 1).padStart(digits, " ");
    const prefix = `${index === bufferSearchState.selected ? ">" : " "} ${lineNumber} │ `;
    return {
      text: `${prefix}${match.lineText}`,
      properties: { matchIndex: index },
      inlineOverlays: [
        { start: 0, end: prefix.length, unit: "char", style: MUTED },
        {
          start: prefix.length + match.lineMatchStart,
          end: prefix.length + match.lineMatchEnd,
          unit: "char",
          style: { fg: SEARCH_MATCH_FG, bg: SEARCH_MATCH_BG, bold: true },
        },
      ],
    };
  });
}

function buildSearchPanel(): WidgetSpec {
  const total = bufferSearchState.matches.length;
  const count = total > 0 ? `${bufferSearchState.selected + 1}/${total}` : "0/0";
  const toolbar: WidgetSpec = {
    kind: "row",
    wrap: false,
    children: [
      { kind: "spacer", cols: 1, flex: false },
      searchInput(bufferSearchState.query),
      { kind: "spacer", cols: 1, flex: true },
      {
        kind: "raw",
        entries: [{ text: count, style: MUTED }],
        key: "buffer-search-count",
      },
      { kind: "spacer", cols: 1, flex: false },
      searchButton("↑", "buffer-search-previous", total === 0, true),
      searchButton("↓", "buffer-search-next", total === 0, true),
      searchButton("All Results", "buffer-search-all", total === 0),
      searchButton("×", "buffer-search-close", false, true),
      { kind: "spacer", cols: 1, flex: false },
    ],
  };

  if (!bufferSearchState.showResults) {
    return toolbar;
  }

  const entries = resultEntries();
  const resultList: WidgetSpec = entries.length > 0
    ? {
      kind: "list",
      items: entries,
      itemKeys: entries.map((_entry, index) => `match:${index}`),
      selectedIndex: bufferSearchState.selected,
      focusable: true,
      key: RESULTS_LIST_KEY,
    }
    : {
      kind: "raw",
      entries: [{
        text: bufferSearchState.query
          ? `No matches for “${bufferSearchState.query}”`
          : "Type a search term.",
        style: MUTED,
      }],
    };

  return {
    kind: "col",
    children: [
      toolbar,
      { kind: "divider", ch: "─", style: MUTED },
      resultList,
    ],
  };
}

function updateSearchPanel(): void {
  if (bufferSearchState.panelBufferId === null) return;
  bufferSearchEditor.updateWidgetPanel(BUFFER_SEARCH_WIDGET_ID, buildSearchPanel());
  if (bufferSearchState.showResults && bufferSearchState.matches.length > 0) {
    bufferSearchEditor.widgetMutate(BUFFER_SEARCH_WIDGET_ID, {
      kind: "setSelectedIndex",
      widgetKey: RESULTS_LIST_KEY,
      index: bufferSearchState.selected,
    });
  }
}

function clearSearchDecorations(): void {
  const bufferId = bufferSearchState.sourceBufferId;
  if (bufferId === null) return;
  bufferSearchEditor.clearNamespace(bufferId, MATCH_NAMESPACE);
  bufferSearchEditor.clearNamespace(bufferId, CURRENT_NAMESPACE);
  bufferSearchEditor.clearScrollbarMarkers(bufferId, MATCH_NAMESPACE);
}

function resetSearchState(): void {
  if (bufferSearchState.editTimer !== null) {
    bufferSearchEditor.clearInterval(bufferSearchState.editTimer);
  }
  bufferSearchState.sourceBufferId = null;
  bufferSearchState.sourceSplitId = null;
  bufferSearchState.panelBufferId = null;
  bufferSearchState.panelSplitId = null;
  bufferSearchState.query = "";
  bufferSearchState.matches = [];
  bufferSearchState.selected = 0;
  bufferSearchState.showResults = false;
  bufferSearchState.anchorPosition = 0;
  bufferSearchState.opening = false;
  bufferSearchState.searchToken++;
  bufferSearchState.editTimer = null;
}

async function collapseSearchDockIfUnused(
  panelBufferId: number | null,
  panelSplitId: number | null,
  closeBuffer: boolean,
): Promise<void> {
  if (closeBuffer && panelBufferId !== null) {
    bufferSearchEditor.closeBuffer(panelBufferId, true);
  }
  if (panelSplitId === null) return;
  await bufferSearchEditor.flush();
  const pane = bufferSearchEditor.describeWorkspace().panes.find(
    (candidate) => candidate.splitId === panelSplitId,
  );
  // Closing a dock tab may expose another plugin's virtual panel. Keep the
  // shared Utility Dock in that case; collapse it only when Fresh substituted
  // an ordinary source file for the closed final utility tab.
  if (pane?.kind === "file") bufferSearchEditor.closeSplit(panelSplitId);
}

function closeBufferSearch(): void {
  const sourceBufferId = bufferSearchState.sourceBufferId;
  const sourceSplitId = bufferSearchState.sourceSplitId;
  const panelBufferId = bufferSearchState.panelBufferId;
  const panelSplitId = bufferSearchState.panelSplitId;
  clearSearchDecorations();
  bufferSearchEditor.unmountWidgetPanel(BUFFER_SEARCH_WIDGET_ID);
  resetSearchState();
  void collapseSearchDockIfUnused(panelBufferId, panelSplitId, true).catch(() => {});
  if (sourceSplitId !== null) bufferSearchEditor.focusSplit(sourceSplitId);
  if (sourceBufferId !== null) bufferSearchEditor.setStatus("Buffer search closed");
}
registerHandler("freshone_buffer_search_close", closeBufferSearch);

bufferSearchEditor.registerCommand(
  "Close Find in Buffer Results",
  "Close the current-buffer search bar and clear its highlights",
  "freshone_buffer_search_close",
  null,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function collectMatches(text: string, query: string): BufferSearchMatch[] {
  if (!query || query.includes("\n") || query.includes("\r")) return [];
  let expression: RegExp;
  try {
    expression = new RegExp(escapeRegExp(query), "giu");
  } catch {
    return [];
  }

  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }

  const matches: BufferSearchMatch[] = [];
  let line = 0;
  let previousCharEnd = 0;
  let previousByteEnd = 0;
  let found: RegExpExecArray | null;
  while ((found = expression.exec(text)) !== null) {
    const charStart = found.index;
    const charEnd = found.index + found[0].length;
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= charStart) line++;

    const byteStart = previousByteEnd + bufferSearchEditor.utf8ByteLength(
      text.slice(previousCharEnd, charStart),
    );
    const byteEnd = byteStart + bufferSearchEditor.utf8ByteLength(found[0]);
    previousCharEnd = charEnd;
    previousByteEnd = byteEnd;

    const lineStart = lineStarts[line];
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd--;
    const visibleMatchEnd = Math.min(charEnd, lineEnd);

    matches.push({
      start: byteStart,
      end: byteEnd,
      line,
      lineText: text.slice(lineStart, lineEnd),
      lineMatchStart: codePointLength(text.slice(lineStart, charStart)),
      lineMatchEnd: codePointLength(text.slice(lineStart, visibleMatchEnd)),
    });
  }
  return matches;
}

function nearestMatchIndex(position: number): number {
  if (bufferSearchState.matches.length === 0) return 0;
  const found = bufferSearchState.matches.findIndex((match) => match.start >= position);
  return found >= 0 ? found : 0;
}

function renderSearchDecorations(): void {
  const bufferId = bufferSearchState.sourceBufferId;
  if (bufferId === null) return;
  bufferSearchEditor.clearNamespace(bufferId, MATCH_NAMESPACE);
  bufferSearchEditor.clearNamespace(bufferId, CURRENT_NAMESPACE);

  for (const match of bufferSearchState.matches) {
    bufferSearchEditor.addOverlay(bufferId, MATCH_NAMESPACE, match.start, match.end, {
      fg: SEARCH_MATCH_FG,
      bg: SEARCH_MATCH_BG,
    });
  }
  const current = bufferSearchState.matches[bufferSearchState.selected];
  if (current) {
    bufferSearchEditor.addOverlay(bufferId, CURRENT_NAMESPACE, current.start, current.end, {
      bg: CURRENT_MATCH_BG,
      bold: true,
    });
  }
  bufferSearchEditor.setScrollbarMarkers(
    bufferId,
    MATCH_NAMESPACE,
    bufferSearchState.matches.map((match) => ({
      position: match.start,
      end: match.end,
      color: SEARCH_MATCH_BG,
      priority: 20,
    })),
  );
}

function jumpToMatch(index: number): void {
  const bufferId = bufferSearchState.sourceBufferId;
  const splitId = bufferSearchState.sourceSplitId;
  if (
    bufferId === null ||
    splitId === null ||
    bufferSearchState.matches.length === 0
  ) return;
  const count = bufferSearchState.matches.length;
  bufferSearchState.selected = ((index % count) + count) % count;
  const match = bufferSearchState.matches[bufferSearchState.selected];
  bufferSearchEditor.setSplitBuffer(splitId, bufferId);
  bufferSearchEditor.setBufferCursor(bufferId, match.start);
  bufferSearchEditor.scrollToLineCenter(splitId, bufferId, match.line);
  renderSearchDecorations();
  updateSearchPanel();
}

function nextMatch(): void {
  jumpToMatch(bufferSearchState.selected + 1);
}
registerHandler("freshone_buffer_search_next", nextMatch);

function previousMatch(): void {
  jumpToMatch(bufferSearchState.selected - 1);
}
registerHandler("freshone_buffer_search_previous", previousMatch);

async function updateSearch(query: string): Promise<void> {
  const bufferId = bufferSearchState.sourceBufferId;
  if (bufferId === null) return;
  const token = ++bufferSearchState.searchToken;
  bufferSearchState.query = query;

  if (!query || query.includes("\n") || query.includes("\r")) {
    bufferSearchState.matches = [];
    bufferSearchState.selected = 0;
    renderSearchDecorations();
    updateSearchPanel();
    return;
  }

  try {
    const text = await bufferSearchEditor.getBufferText(bufferId);
    if (token !== bufferSearchState.searchToken || bufferId !== bufferSearchState.sourceBufferId) return;
    const previous = bufferSearchState.matches[bufferSearchState.selected];
    bufferSearchState.matches = collectMatches(text, query);
    if (previous) {
      bufferSearchState.selected = nearestMatchIndex(previous.start);
    } else {
      bufferSearchState.selected = nearestMatchIndex(bufferSearchState.anchorPosition);
    }
    renderSearchDecorations();
    updateSearchPanel();
    if (bufferSearchState.matches.length > 0) {
      jumpToMatch(bufferSearchState.selected);
    }
  } catch (error) {
    if (token === bufferSearchState.searchToken) {
      bufferSearchEditor.setStatus(`Buffer search failed: ${String(error)}`);
    }
  }
}

function showAllResults(): void {
  if (bufferSearchState.matches.length === 0 || bufferSearchState.panelSplitId === null) return;
  bufferSearchState.showResults = true;
  // The source pane is the first (top) child and receives 65% of the height.
  bufferSearchEditor.setSplitRatio(bufferSearchState.panelSplitId, 0.65);
  updateSearchPanel();
  bufferSearchEditor.widgetMutate(BUFFER_SEARCH_WIDGET_ID, {
    kind: "setFocusKey",
    widgetKey: RESULTS_LIST_KEY,
  });
  bufferSearchEditor.setStatus(
    `${bufferSearchState.matches.length} result(s). Click a row to jump; Esc closes the panel.`,
  );
}
registerHandler("freshone_buffer_search_show_all", showAllResults);

async function startBufferSearch(): Promise<void> {
  if (bufferSearchState.opening) return;
  const activeBufferId = bufferSearchEditor.getActiveBufferId();
  if (activeBufferId === bufferSearchState.panelBufferId) {
    bufferSearchEditor.widgetMutate(BUFFER_SEARCH_WIDGET_ID, {
      kind: "setFocusKey",
      widgetKey: SEARCH_INPUT_KEY,
    });
    return;
  }
  const info = bufferSearchEditor.getBufferInfo(activeBufferId);
  if (!info || info.is_virtual || info.is_terminal) {
    bufferSearchEditor.setStatus("Find in Buffer requires a text buffer.");
    return;
  }

  if (bufferSearchState.sourceBufferId !== null) closeBufferSearch();
  bufferSearchState.opening = true;
  bufferSearchState.sourceBufferId = activeBufferId;
  bufferSearchState.sourceSplitId = bufferSearchEditor.getActiveSplitId();

  try {
    const cursor = bufferSearchEditor.getPrimaryCursor();
    bufferSearchState.anchorPosition = cursor?.position ?? 0;
    let initial = "";
    if (cursor?.selection && cursor.selection.end > cursor.selection.start) {
      initial = await bufferSearchEditor.getBufferText(
        activeBufferId,
        cursor.selection.start,
        cursor.selection.end,
      );
      if (initial.includes("\n") || initial.includes("\r")) initial = "";
    }
    bufferSearchState.query = initial;

    const panel = await bufferSearchEditor.createVirtualBufferInSplit({
      name: BUFFER_SEARCH_PANEL_NAME,
      mode: BUFFER_SEARCH_MODE,
      readOnly: true,
      entries: [],
      direction: "horizontal",
      ratio: 0.88,
      panelId: "freshone-buffer-search",
      role: "utility_dock",
      editingDisabled: true,
      showLineNumbers: false,
      showCursors: false,
      lineWrap: false,
      scrollable: false,
    });
    bufferSearchState.panelBufferId = panel.bufferId;
    bufferSearchState.panelSplitId = panel.splitId ?? bufferSearchEditor.getActiveSplitId();
    bufferSearchEditor.mountWidgetPanel(
      BUFFER_SEARCH_WIDGET_ID,
      panel.bufferId,
      buildSearchPanel(),
      { autoFocusFirst: true },
    );
    bufferSearchEditor.widgetMutate(BUFFER_SEARCH_WIDGET_ID, {
      kind: "setFocusKey",
      widgetKey: SEARCH_INPUT_KEY,
    });
    if (initial) await updateSearch(initial);
  } catch (error) {
    const panelBufferId = bufferSearchState.panelBufferId;
    const panelSplitId = bufferSearchState.panelSplitId;
    clearSearchDecorations();
    bufferSearchEditor.unmountWidgetPanel(BUFFER_SEARCH_WIDGET_ID);
    resetSearchState();
    void collapseSearchDockIfUnused(panelBufferId, panelSplitId, true).catch(() => {});
    bufferSearchEditor.setStatus(`Unable to open Find in Buffer: ${String(error)}`);
  } finally {
    bufferSearchState.opening = false;
  }
}
registerHandler("freshone_buffer_search_start", startBufferSearch);

bufferSearchEditor.registerCommand(
  "Find in Buffer",
  "Open an interactive current-buffer search bar in the Utility Dock",
  "freshone_buffer_search_start",
  null,
);

function sendTextInputKey(key: string): void {
  bufferSearchEditor.widgetCommand(BUFFER_SEARCH_WIDGET_ID, {
    kind: "textInputKey",
    key,
  });
}

export function handleBufferSearchTextInput(data: { text: string }): boolean {
  if (
    bufferSearchState.panelBufferId === null ||
    bufferSearchEditor.getActiveBufferId() !== bufferSearchState.panelBufferId ||
    !data?.text
  ) return false;
  bufferSearchEditor.widgetCommand(BUFFER_SEARCH_WIDGET_ID, {
    kind: "textInputChar",
    text: data.text,
  });
  return true;
}

function searchBackspace(): void { sendTextInputKey("Backspace"); }
function searchDelete(): void { sendTextInputKey("Delete"); }
function searchLeft(): void { sendTextInputKey("Left"); }
function searchRight(): void { sendTextInputKey("Right"); }
function searchHome(): void { sendTextInputKey("Home"); }
function searchEnd(): void { sendTextInputKey("End"); }
function searchTab(): void {
  bufferSearchEditor.widgetCommand(BUFFER_SEARCH_WIDGET_ID, { kind: "focusAdvance", delta: 1 });
}
function searchShiftTab(): void {
  bufferSearchEditor.widgetCommand(BUFFER_SEARCH_WIDGET_ID, { kind: "focusAdvance", delta: -1 });
}
registerHandler("freshone_buffer_search_backspace", searchBackspace);
registerHandler("freshone_buffer_search_delete", searchDelete);
registerHandler("freshone_buffer_search_left", searchLeft);
registerHandler("freshone_buffer_search_right", searchRight);
registerHandler("freshone_buffer_search_home", searchHome);
registerHandler("freshone_buffer_search_end", searchEnd);
registerHandler("freshone_buffer_search_tab", searchTab);
registerHandler("freshone_buffer_search_shift_tab", searchShiftTab);

bufferSearchEditor.defineMode(
  BUFFER_SEARCH_MODE,
  [
    ["Escape", "freshone_buffer_search_close"],
    ["C-q", "freshone_buffer_search_close"],
    ["Return", "freshone_buffer_search_next"],
    ["Up", "freshone_buffer_search_previous"],
    ["Down", "freshone_buffer_search_next"],
    ["Tab", "freshone_buffer_search_tab"],
    ["S-Tab", "freshone_buffer_search_shift_tab"],
    ["Backspace", "freshone_buffer_search_backspace"],
    ["Delete", "freshone_buffer_search_delete"],
    ["Left", "freshone_buffer_search_left"],
    ["Right", "freshone_buffer_search_right"],
    ["Home", "freshone_buffer_search_home"],
    ["End", "freshone_buffer_search_end"],
  ],
  true,
  true,
  false,
);

function onSearchWidgetEvent(data: {
  panel_id: number;
  widget_key: string;
  event_type: string;
  payload: Record<string, unknown>;
}): void {
  if (data.panel_id !== BUFFER_SEARCH_WIDGET_ID) return;

  if (data.event_type === "change" && data.widget_key === SEARCH_INPUT_KEY) {
    const value = data.payload?.value;
    if (typeof value === "string" && value !== bufferSearchState.query) {
      void updateSearch(value).catch((error) => {
        bufferSearchEditor.setStatus(`Buffer search failed: ${String(error)}`);
      });
    }
    return;
  }

  if (data.event_type === "select" && data.widget_key === RESULTS_LIST_KEY) {
    const index = data.payload?.index;
    if (typeof index === "number") {
      bufferSearchState.selected = Math.max(
        0,
        Math.min(index, bufferSearchState.matches.length - 1),
      );
      renderSearchDecorations();
      if (data.payload?.via === "click") jumpToMatch(bufferSearchState.selected);
    }
    return;
  }

  if (data.event_type !== "activate") return;
  switch (data.widget_key) {
    case "buffer-search-previous":
      previousMatch();
      break;
    case "buffer-search-next":
      nextMatch();
      break;
    case "buffer-search-all":
      showAllResults();
      break;
    case "buffer-search-close":
      closeBufferSearch();
      break;
    case RESULTS_LIST_KEY: {
      const index = data.payload?.index;
      if (typeof index === "number") jumpToMatch(index);
      break;
    }
  }
}
registerHandler("freshone_buffer_search_widget_event", onSearchWidgetEvent);
bufferSearchEditor.on("widget_event", "freshone_buffer_search_widget_event");

function onSearchBufferClosed(data: { buffer_id: number }): void {
  if (data.buffer_id === bufferSearchState.panelBufferId) {
    const sourceSplitId = bufferSearchState.sourceSplitId;
    const splitId = bufferSearchState.panelSplitId;
    clearSearchDecorations();
    bufferSearchEditor.unmountWidgetPanel(BUFFER_SEARCH_WIDGET_ID);
    resetSearchState();
    void collapseSearchDockIfUnused(data.buffer_id, splitId, false).catch(() => {});
    if (sourceSplitId !== null) bufferSearchEditor.focusSplit(sourceSplitId);
    return;
  }
  if (data.buffer_id === bufferSearchState.sourceBufferId) closeBufferSearch();
}
registerHandler("freshone_buffer_search_buffer_closed", onSearchBufferClosed);
bufferSearchEditor.on("buffer_closed", "freshone_buffer_search_buffer_closed");

function scheduleSearchRefresh(data: { buffer_id: number }): void {
  if (
    data.buffer_id !== bufferSearchState.sourceBufferId ||
    bufferSearchState.panelBufferId === null ||
    !bufferSearchState.query
  ) return;
  if (bufferSearchState.editTimer !== null) {
    bufferSearchEditor.clearInterval(bufferSearchState.editTimer);
  }
  bufferSearchState.editTimer = bufferSearchEditor.setTimeout(
    120,
    "freshone_buffer_search_refresh_after_edit",
  );
}
registerHandler("freshone_buffer_search_schedule_refresh", scheduleSearchRefresh);
bufferSearchEditor.on("after_insert", "freshone_buffer_search_schedule_refresh");
bufferSearchEditor.on("after_delete", "freshone_buffer_search_schedule_refresh");

function refreshSearchAfterEdit(): void {
  bufferSearchState.editTimer = null;
  if (!bufferSearchState.query || bufferSearchState.sourceBufferId === null) return;
  void updateSearch(bufferSearchState.query).catch(() => {});
}
registerHandler("freshone_buffer_search_refresh_after_edit", refreshSearchAfterEdit);
