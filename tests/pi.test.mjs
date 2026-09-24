import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Exercise the plugin with Fresh's filesystem and widget API shapes.
test('Pi Sessions filters by the JSONL header cwd and resumes the selected file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshone-pi-test-'));
  const currentCwd = 'D:\\Project\\freshone';
  const directory = path.join(root, '.pi', 'agent', 'sessions', '--D--Project-freshone--');
  fs.mkdirSync(directory, { recursive: true });
  const session = path.join(directory, '2026-09-23T02-21-11-032Z_example.jsonl');
  const other = path.join(directory, '2026-09-22T02-21-11-032Z_other.jsonl');
  fs.writeFileSync(session, JSON.stringify({ type: 'session', cwd: currentCwd, timestamp: '2026-09-23T02:21:11.000Z' }) + '\n' +
    JSON.stringify({ type: 'session_info', name: 'Example' }) + '\n');
  fs.writeFileSync(other, JSON.stringify({ type: 'session', cwd: 'D:\\Project\\other' }) + '\n');
  const handlers = new Map();
  const events = new Map();
  const commands = new Map();
  const mounts = [];
  const terminals = [];
  const watches = [];
  const statuses = [];
  let dockBufferId = null;
  let dockSplitId = null;
  let dockOpens = 0;
  const editor = {
    getEnv: (name) => name === 'USERPROFILE' ? root : null,
    getCwd: () => '\\\\?\\D:\\Project\\freshone',
    pathJoin: (...parts) => path.join(...parts),
    localPath: (p) => p,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    readDir: (p) => fs.readdirSync(p, { withFileTypes: true }).map((entry) => ({ name: entry.name, is_file: entry.isFile(), is_dir: entry.isDirectory() })),
    // Some Fresh backends implement fileExists for files but not directories.
    fileExists: (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
    watchPath: async (p) => { watches.push(p); return watches.length; },
    unwatchPath: () => true,
    mountSidebarSection: (_id, spec) => { mounts.push(spec); return true; },
    updateFloatingWidget: (_id, spec) => { mounts.push(spec); return true; },
    widgetMutate: () => true,
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, _description, handler) => { commands.set(name, handler); return true; },
    setInterval: () => 1,
    describeWorkspace: () => ({ panes: [
      { splitId: 1, bufferId: 1, kind: 'file' },
      ...(dockSplitId === null ? [] : [{ splitId: dockSplitId, bufferId: dockBufferId, kind: 'virtual' }]),
    ] }),
    createVirtualBufferInSplit: async (opts) => {
      assert.equal(opts.role, 'utility_dock');
      dockOpens++;
      dockSplitId = 2;
      dockBufferId = 100;
      return { bufferId: 100, splitId: 2 };
    },
    focusSplit: (id) => { assert.equal(id, 2); return true; },
    flush: async () => {},
    createTerminal: async (opts) => {
      terminals.push(opts);
      dockBufferId = 101;
      return { bufferId: 101, terminalId: 7, splitId: null };
    },
    closeBuffer: (id) => { if (id === 101) dockBufferId = 100; return true; },
    closeTerminal: () => true,
    setStatus: (message) => { statuses.push(message); },
  };
  globalThis.getEditor = () => editor;
  globalThis.registerHandler = (name, fn) => handlers.set(name, fn);
  try {
    const { registerPiSessions } = await import('../lib/pi.ts');
    registerPiSessions();
    const list = mounts.at(-1).children[0];
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].text, 'Example');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(watches.some((p) => path.resolve(p) === path.resolve(directory)));
    await handlers.get(commands.get('Pi Resume Session'))();
    assert.equal(terminals[0].command[1], '--session');
    assert.equal(path.resolve(terminals[0].command[2]), path.resolve(session));
    assert.deepEqual(terminals[0].resume, terminals[0].command);
    assert.equal(terminals[0].cwd, '\\\\?\\D:\\Project\\freshone');
    assert.equal(terminals[0].allowScript, true);
    assert.equal('direction' in terminals[0], false);
    assert.equal(dockSplitId, 2);

    // Enter/double-click uses the same dock path, not the old split API.
    handlers.get(events.get('widget_event'))({
      panel_id: 73112, widget_key: 'freshone-pi-sessions-list', event_type: 'activate', payload: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terminals.length, 2);
    assert.deepEqual(terminals[1].command, terminals[0].command);

    // Missing selected session: refresh instead of opening an invalid path.
    fs.rmSync(session);
    await handlers.get(commands.get('Pi Resume Session'))();
    assert.equal(terminals.length, 2);

    // Fresh's terminal failure reports an error and can be retried.
    fs.writeFileSync(session, JSON.stringify({ type: 'session', cwd: currentCwd }) + '\n');
    handlers.get(commands.get('Pi Refresh Sessions'))();
    editor.createTerminal = async () => { throw new Error('spawn failed'); };
    await handlers.get(commands.get('Pi Resume Session'))();
    assert.match(statuses.at(-1), /Unable to resume pi session: Error: spawn failed/);

    // A pending resume prevents New Session from launching another terminal;
    // failure releases the guard for a later attempt.
    let release;
    editor.createTerminal = (opts) => {
      terminals.push(opts);
      return new Promise((resolve) => { release = resolve; });
    };
    const pending = handlers.get(commands.get('Pi Resume Session'))();
    await handlers.get(commands.get('Pi New Session'))();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terminals.length, 3);
    assert.equal(dockOpens, 4); // 2 successes, 1 failed spawn, 1 pending resume.
    dockBufferId = 101;
    release({ bufferId: 101, terminalId: 7, splitId: null });
    await pending;
    assert.equal(statuses.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Pi New Session attaches directly to the Utility Dock without a transient terminal split', async () => {
  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  let cwd = 'D:/first';
  let dock = null;
  let activeSplit = 1;
  let nextBuffer = 10;
  const editor = {
    getEnv: (name) => name === 'OS' ? 'Windows_NT' : null,
    getCwd: () => cwd,
    localPath: (p) => p,
    readDir: () => [],
    readFile: () => null,
    watchPath: async () => 1,
    mountSidebarSection: () => true,
    registerCommand: (name, _description, handler) => { commands.set(name, handler); return true; },
    on: () => true,
    setInterval: () => 1,
    createVirtualBufferInSplit: async (opts) => {
      calls.push(['dock', opts]);
      const bufferId = nextBuffer++;
      dock = { splitId: 31, bufferId, kind: 'virtual', previous: dock };
      activeSplit = 31;
      return { bufferId, splitId: 31 };
    },
    createTerminal: async (opts) => {
      calls.push(['terminal', opts]);
      assert.equal(activeSplit, 31);
      assert.ok(!('direction' in opts), 'passing direction would create a visible source split');
      const bufferId = nextBuffer++;
      dock = { splitId: 31, bufferId, kind: 'terminal', previous: dock };
      return { bufferId, terminalId: bufferId + 100, splitId: null };
    },
    describeWorkspace: () => ({ panes: [
      { splitId: 1, bufferId: 1, kind: 'file' },
      ...(dock ? [{ splitId: 31, bufferId: dock.bufferId, kind: dock.kind }] : []),
    ] }),
    flush: async () => {},
    closeBuffer: (id) => {
      calls.push(['closeBuffer', id]);
      if (dock?.bufferId === id) dock = dock.previous ?? { splitId: 31, bufferId: 1, kind: 'file' };
      else if (dock?.previous?.bufferId === id) dock.previous = dock.previous.previous;
      return true;
    },
    focusSplit: (id) => { calls.push(['focus', id]); activeSplit = id; return true; },
    closeSplit: (id) => { calls.push(['closeSplit', id]); if (id === 31) dock = null; return true; },
    closeTerminal: (id) => { calls.push(['closeTerminal', id]); return true; },
    setStatus: (message) => { calls.push(['status', message]); },
  };
  globalThis.getEditor = () => editor;
  globalThis.registerHandler = (name, fn) => handlers.set(name, fn);
  const { registerPiSessions } = await import('../lib/pi.ts?new-session');
  registerPiSessions();
  const start = handlers.get(commands.get('Pi New Session'));
  assert.equal(typeof start, 'function');
  cwd = 'D:/changed';
  await start();
  assert.equal(calls[0][0], 'dock');
  assert.equal(calls[0][1].role, 'utility_dock');
  assert.deepEqual(calls.slice(1), [
    ['focus', 31], ['terminal', {
      cwd: 'D:/changed', command: ['pi.cmd'], title: 'pi', allowScript: true,
    }], ['closeBuffer', 10],
  ]);
  assert.deepEqual(editor.describeWorkspace().panes.map((pane) => pane.kind), ['file', 'terminal']);

  // Existing dock is reused without creating another split or removing its tab.
  await start();
  assert.deepEqual(editor.describeWorkspace().panes.map((pane) => pane.splitId), [1, 31]);
  assert.equal(calls.some(([name]) => name === 'closeSplit'), false);

  // Failed spawn preserves the existing dock and does not leave a placeholder.
  editor.createTerminal = async () => { throw new Error('pi not installed'); };
  const previousBuffer = dock.bufferId;
  await start();
  assert.equal(dock.bufferId, previousBuffer);
  assert.match(calls.at(-1)[1], /Unable to start pi session: Error: pi not installed/);

  // On the first invocation a failed spawn must also collapse a new empty dock.
  dock = null;
  activeSplit = 1;
  await start();
  assert.equal(dock, null);
  assert.deepEqual(calls.slice(-3).map((call) => call[0]), ['closeBuffer', 'closeSplit', 'status']);

  // A second invocation while the first is pending is ignored.
  let release;
  editor.createTerminal = () => new Promise((resolve) => { release = resolve; });
  const pending = start();
  await start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  dock = { splitId: 31, bufferId: 999, kind: 'terminal', previous: dock };
  release({ bufferId: 999, terminalId: 1099, splitId: null });
  await pending;
  assert.equal(calls.filter(([name]) => name === 'dock').length, 5);
});
