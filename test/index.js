// Makes `node --test test/` work on Node 22, where a directory argument is passed to `node` as-is
// (and would fail with "Cannot find module .../test"). When the runner executes this directory as
// the entry point it loads every *.test.mjs in this process, one after another.
// Under plain `node --test` (no argument) the runner executes this file as "index.js"; then it does nothing,
// because the runner is already running each *.test.mjs in its own process.
const path = require('node:path');
const fs = require('node:fs');
if (path.basename(process.argv[1] || '') === 'test') {
  (async () => {
    const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.mjs')).sort();
    for (const f of files) await import(path.join(__dirname, f));
  })().catch((e) => { console.error(e); process.exitCode = 1; });
}
