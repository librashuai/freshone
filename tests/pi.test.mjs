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
  globalThis.getEditor = () => ({
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
    createTerminal: async (opts) => { terminals.push(opts); return {}; },
  });
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
