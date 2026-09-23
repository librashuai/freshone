import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let sequence = 0;
async function harness({ cwd = '/project', spawn, selection = '' } = {}) {
  const handlers = new Map();
  const calls = [];
  const popups = [];
  const opened = [];
  let panel;
  let activeBuffer = 2;
  const editor = {
    getCwd: () => cwd,
    spawnProcess: (command, args, dir) => {
      calls.push({ command, args, dir });
      return spawn(command, args, dir);
    },
    getActiveSplitId: () => 1,
    getActiveBufferId: () => activeBuffer,
    describeWorkspace: () => ({ panes: [{ splitId: 1, bufferId: 2, kind: 'file', x: 0, y: 0 }] }),
    getPrimaryCursor: () => ({ selection: selection ? { start: 0, end: selection.length } : null }),
    getBufferText: async () => selection,
    createVirtualBufferInSplit: async () => ({ bufferId: 3, splitId: 4 }),
    mountWidgetPanel: (_id, _buffer, spec) => { panel = spec; activeBuffer = 3; },
    updateWidgetPanel: (_id, spec) => { panel = spec; },
    widgetMutate: () => {},
    widgetCommand: () => {},
    listSplits: () => [{ splitId: 4, viewport: { width: 100, height: 20 } }],
    readFile: (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '\n'.repeat(6) + '🙂 CAFÉ café\n',
    authorityPath: (file) => file,
    pathJoin: (...parts) => path.join(...parts),
    pathBasename: (file) => path.basename(file),
    utf8ByteLength: (str) => Buffer.byteLength(str),
    stringWidth: (str) => [...str].length,
    charWidth: () => 1,
    setStatus: (value) => { editor.status = value; },
    showActionPopup: (popup) => popups.push(popup),
    registerCommand: () => {},
    defineMode: () => {},
    on: () => {},
    delay: async () => {},
    openFileInSplit: (...args) => opened.push(args),
    unmountWidgetPanel: () => {},
    closeBuffer: () => {},
    flush: async () => {},
    focusSplit: () => {},
  };
  globalThis.getEditor = () => editor;
  globalThis.registerHandler = (name, handler) => handlers.set(name, handler);
  await import(`../lib/find_in_files.ts?test=${++sequence}`);
  return {
    handlers, calls, editor, popups, opened,
    start: () => handlers.get('freshone_find_files_start')(),
    search: () => handlers.get('freshone_find_files_execute')(),
    change: (value) => handlers.get('freshone_find_files_widget_event')({
      panel_id: 73110, widget_key: 'find-files-input', event_type: 'change', payload: { value },
    }),
    panel: () => panel,
    tree: () => panel.children[2].children[0].child,
    context: () => panel.children[2].children[1].child,
  };
}
const result = (stdout, exit_code = 0, stderr = '') => ({ result: Promise.resolve({ stdout, stderr, exit_code }), kill: async () => {} });
const event = (type, data) => JSON.stringify({ type, data }) + '\n';
const match = (file, text, line_number, submatches) => event('match', {
  path: { text: file }, lines: { text }, line_number, submatches,
});

test('ripgrep JSON maps UTF-8 offsets to code points, groups matches and opens the selected location', async () => {
  const output = event('begin', { path: { text: 'src/a file.ts' } }) +
    match('src/a file.ts', '🙂 CAFÉ café\r\n', 7, [{ start: 5, end: 10 }, { start: 11, end: 16 }]) +
    event('summary', {});
  const h = await harness({ selection: 'café', spawn: (_cmd, args) => result(args[0] === '--version' ? '' : output) });
  await h.start();
  await h.search();
  assert.deepEqual(h.calls[1], { command: 'rg', args: [
    '--json', '--fixed-strings', '--ignore-case', '--no-require-git', '--max-filesize', '10M', '--', 'café', '.',
  ], dir: '/project' });
  assert.equal(h.tree().nodes[0].text.text, 'a file.ts (2)');
  assert.equal(h.tree().nodes[1].text.text, '🙂 CAFÉ café');
  assert.deepEqual(h.tree().nodes[1].text.inlineOverlays[0].start, 2);
  assert.deepEqual(h.tree().nodes[2].text.inlineOverlays[0].start, 7);
  assert.equal(h.context().items[6].text.includes('🙂 CAFÉ café'), true);
  h.handlers.get('freshone_find_files_widget_event')({ panel_id: 73110, widget_key: 'find-files-results', event_type: 'select', payload: { index: 2 } });
  h.handlers.get('freshone_find_files_widget_event')({ panel_id: 73110, widget_key: 'find-files-context', event_type: 'select', payload: { index: 6, via: 'click' } });
  h.handlers.get('freshone_find_files_widget_event')({ panel_id: 73110, widget_key: 'find-files-context', event_type: 'select', payload: { index: 6, via: 'click' } });
  assert.deepEqual(h.opened[0], [1, path.join('/project', 'src/a file.ts'), 7, 8]);
});

test('no match (exit 1), error (exit 2), and missing rg are handled separately', async () => {
  const h = await harness({ spawn: (_cmd, args) => args[0] === '--version' ? result('', 0) : result('', 1) });
  await h.start(); h.change('any'); await h.search();
  assert.equal(h.editor.status, 'Find in Files: 0 match(es)');
  assert.equal(h.tree().nodes[0].text.text, 'No matches');
  const failed = await harness({ selection: 'x', spawn: (_cmd, args) => result('', args[0] === '--version' ? 0 : 2, 'permission denied') });
  await failed.start(); await failed.search();
  assert.match(failed.editor.status, /Search failed: Error: permission denied/);
  const missing = await harness({ spawn: () => { throw Error('ENOENT'); } });
  await missing.start();
  assert.match(missing.popups[0].message, /ripgrep/);
  assert.equal(missing.panel(), undefined);
});

test('changing query cancels an in-flight rg and ignores its late output', async () => {
  let resolve;
  let killed = 0;
  const h = await harness({ selection: 'old', spawn: (_cmd, args) => args[0] === '--version' ? result('', 0) : {
    result: new Promise((r) => { resolve = r; }), kill: async () => { killed++; },
  } });
  await h.start();
  const pending = h.search();
  h.change('new');
  resolve({ stdout: match('old.txt', 'old\n', 1, [{ start: 0, end: 3 }]), stderr: '', exit_code: 0 });
  await pending;
  assert.equal(killed, 1);
  assert.equal(h.tree().nodes.some((node) => node.text.text === 'old.txt (1)'), false);
  assert.match(h.editor.status, /Checking for ripgrep/);
});

test('caps results at 10000 and marks truncation only if there is an extra match', async () => {
  const submatches = Array.from({ length: 10001 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 }));
  const output = match('many.txt', 'x '.repeat(10001) + '\n', 1, submatches);
  const h = await harness({ selection: 'x', spawn: (_cmd, args) => result(args[0] === '--version' ? '' : output) });
  await h.start(); await h.search();
  assert.equal(h.tree().nodes.length, 10001);
  assert.equal(h.editor.status, 'Find in Files: 10000+ match(es)');
});

test('real ripgrep honors .gitignore, hidden/binary files and fixed-string case-insensitive search', { skip: spawnSync('rg', ['--version']).status !== 0 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'freshone-rg-'));
  try {
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(cwd, 'ignored.txt'), 'a.b\n');
    fs.writeFileSync(path.join(cwd, '.hidden'), 'a.b\n');
    fs.writeFileSync(path.join(cwd, 'binary'), Buffer.from([97, 46, 98, 0, 10]));
    fs.writeFileSync(path.join(cwd, 'visible.txt'), 'A.B\n');
    const h = await harness({ cwd, selection: 'a.b', spawn: (cmd, args, dir) => {
      const run = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });
      return result(run.stdout ?? '', run.status ?? 2, run.stderr ?? String(run.error));
    } });
    await h.start(); await h.search();
    assert.equal(h.tree().nodes[0].text.text, 'visible.txt (1)');
    assert.equal(h.tree().nodes.length, 2);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
