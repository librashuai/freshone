import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let sequence = 0;
async function harness({ cwd = '/project', spawn, selection = '' } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  const popups = [];
  const opened = [];
  const mutations = [];
  let panel;
  let mountCount = 0;
  let unmountCount = 0;
  let focusCount = 0;
  let updates = 0;
  let height = 12;
  let activeBuffer = 2;
  const editor = {
    getCwd: () => cwd,
    spawnProcess: (command, args, dir) => { calls.push({ command, args, dir }); return spawn(command, args, dir); },
    getActiveSplitId: () => 1,
    getActiveBufferId: () => activeBuffer,
    describeWorkspace: () => ({ panes: [{ splitId: 1, bufferId: 2, kind: 'file', x: 0, y: 0 }] }),
    getPrimaryCursor: () => ({ selection: selection ? { start: 0, end: selection.length } : null }),
    getBufferText: async () => selection,
    createVirtualBufferInSplit: async () => ({ bufferId: 3, splitId: 4 }),
    mountWidgetPanel: (_id, _buffer, spec) => { mountCount++; panel = spec; activeBuffer = 3; },
    updateWidgetPanel: (_id, spec) => { updates++; panel = spec; },
    unmountWidgetPanel: () => { unmountCount++; },
    widgetMutate: (_id, mutation) => mutations.push(mutation),
    widgetCommand: (_id, command) => mutations.push(command),
    listSplits: () => [{ splitId: 4, viewport: { width: 100, height } }],
    utf8ByteLength: (str) => Buffer.byteLength(str),
    pathJoin: (...parts) => path.join(...parts),
    setStatus: (text) => { editor.status = text; },
    showActionPopup: (popup) => popups.push(popup),
    openFileInSplit: (...args) => opened.push(args),
    focusSplit: () => { focusCount++; },
    closeBuffer: () => {},
    closeSplit: () => {},
    flush: async () => {},
    on: () => {},
    defineMode: () => {},
    registerCommand: (name, _desc, handler) => commands.set(name, handler),
  };
  globalThis.getEditor = () => editor;
  globalThis.registerHandler = (name, handler) => handlers.set(name, handler);
  const { handleFileFinderTextInput } = await import(`../lib/find_files.ts?test=${++sequence}`);
  return {
    editor, handlers, commands, calls, popups, opened, mutations,
    handleFileFinderTextInput,
    start: () => handlers.get('freshone_find_file_start')(),
    search: () => handlers.get('freshone_find_file_execute')(),
    change: (value) => handlers.get('freshone_find_file_widget_event')({
      panel_id: 73113, widget_key: 'find-file-input', event_type: 'change', payload: { value },
    }),
    click: (index) => handlers.get('freshone_find_file_widget_event')({
      panel_id: 73113, widget_key: 'find-file-list', event_type: 'select', payload: { index, via: 'click' },
    }),
    activate: (index) => handlers.get('freshone_find_file_widget_event')({
      panel_id: 73113, widget_key: 'find-file-list', event_type: 'activate', payload: { index },
    }),
    panel: () => panel,
    counts: () => ({ mountCount, unmountCount, focusCount, updates }),
    resize: async (size) => { height = size; await handlers.get('freshone_find_file_resize')(); },
  };
}
const response = (stdout = '', exit_code = 0, stderr = '') => ({
  result: Promise.resolve({ stdout, exit_code, stderr }), kill: async () => {},
});

test('Find File uses fd filename regex, preserves paths, fixes toolbar while list scrolls and opens rows without closing', async () => {
  const paths = './src/a file.ts\0./src/b.ts\0./src/new\nline.ts\0';
  const h = await harness({ selection: 'src/.*\\.ts$', spawn: (_cmd, args) =>
    response(args[0] === '--version' ? '' : paths) });
  assert.equal(h.commands.get('Find File'), 'freshone_find_file_start');
  await h.start();
  assert.equal(h.handleFileFinderTextInput({ text: 'é' }), true);
  assert.deepEqual(h.mutations.at(-1), { kind: 'textInputChar', text: 'é' });
  assert.equal(h.panel().children[0].children[1].value, 'src/.*\\.ts$');
  await h.search();
  assert.deepEqual(h.calls[1], {
    command: 'fd', args: ['--type', 'f', '--color', 'never', '--no-require-git', '--print0', '--', 'src/.*\\.ts$', '.'], dir: '/project',
  });
  assert.deepEqual(h.panel().children[2].items.map((item) => item.text),
    ['src/a file.ts', 'src/b.ts', 'src/new\nline.ts']);
  assert.equal(h.panel().children[2].visibleRows, 9);
  assert.equal(h.panel().children[0].children[1].value, 'src/.*\\.ts$');
  h.handlers.get('freshone_find_file_next')();
  assert.deepEqual(h.mutations.at(-1), { kind: 'setSelectedIndex', widgetKey: 'find-file-list', index: 1 });
  assert.equal(h.panel().children[0].children[1].value, 'src/.*\\.ts$');
  h.click(1);
  h.click(0);
  h.click(99);
  assert.deepEqual(h.opened, [
    [1, path.join('/project', 'src/b.ts'), 1, 1],
    [1, path.join('/project', 'src/a file.ts'), 1, 1],
  ]);
  assert.deepEqual(h.counts(), { mountCount: 1, unmountCount: 0, focusCount: 0, updates: 2 });
  await h.resize(18);
  assert.equal(h.panel().children[2].visibleRows, 15);
  h.activate(2);
  assert.equal(h.opened.length, 3);
  assert.equal(h.counts().unmountCount, 0);
  h.handlers.get('freshone_find_file_close')();
  assert.equal(h.counts().unmountCount, 1);
  assert.equal(h.handleFileFinderTextInput({ text: 'x' }), false);
});

test('missing fd, invalid regex, no matches, and stale query cancellation', async () => {
  const missing = await harness({ spawn: () => { throw Error('ENOENT'); } });
  await missing.start();
  assert.match(missing.popups[0].message, /requires fd/);
  assert.equal(missing.counts().mountCount, 0);

  const error = await harness({ selection: '[', spawn: (_cmd, args) =>
    response('', args[0] === '--version' ? 0 : 1, 'regex parse error') });
  await error.start(); await error.search();
  assert.match(error.editor.status, /regex parse error/);
  assert.equal(error.panel().children[2].selectedIndex, -1);

  const empty = await harness({ selection: 'missing', spawn: () => response() });
  await empty.start(); await empty.search();
  assert.equal(empty.panel().children[2].items[0].text, 'No files found');

  let resolve;
  let killed = 0;
  const pending = await harness({ selection: 'old', spawn: (_cmd, args) => args[0] === '--version'
    ? response() : { result: new Promise((r) => { resolve = r; }), kill: async () => { killed++; } } });
  await pending.start();
  const search = pending.search();
  pending.change('new');
  resolve({ exit_code: 0, stdout: './old.ts\0', stderr: '' });
  await search;
  assert.equal(killed, 1);
  assert.equal(pending.panel().children[2].selectedIndex, -1);
  assert.equal(pending.panel().children[0].children[1].value, 'new');
  pending.click(0);
  assert.deepEqual(pending.opened, []);
});

test('caps the displayed results at 10000', async () => {
  const files = Array.from({ length: 10001 }, (_, i) => `./file${i}.ts`).join('\0') + '\0';
  const h = await harness({ selection: 'file', spawn: (_cmd, args) => response(args[0] === '--version' ? '' : files) });
  await h.start(); await h.search();
  assert.equal(h.panel().children[2].items.length, 10000);
  assert.equal(h.editor.status, 'Find File: 10000+ files');
});

test('real fd matches filename regex and observes ignore/hidden defaults', { skip: spawnSync('fd', ['--version']).status !== 0 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'freshone-fd-'));
  try {
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'skip.ts\n');
    for (const filename of ['one.ts', 'two.txt', 'skip.ts', '.hidden.ts']) fs.writeFileSync(path.join(cwd, filename), '');
    const h = await harness({ cwd, selection: '\\.ts$', spawn: (command, args, dir) => {
      const run = spawnSync(command, args, { cwd: dir, encoding: 'utf8' });
      return response(run.stdout ?? '', run.status ?? 2, run.stderr ?? String(run.error));
    } });
    await h.start(); await h.search();
    assert.deepEqual(h.panel().children[2].items.map((item) => item.text), ['one.ts']);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
