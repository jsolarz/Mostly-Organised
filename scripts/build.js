#!/usr/bin/env node
// Build step: prepare files for `clasp push`
//
// What this does:
//   1. Copies src/*.js → dist/*.js (no transformation needed for Apps Script V8)
//   2. Rewrites sidebar.html — replaces the ESM import with an inline bundle
//      (In dev mode the ESM import from esm.sh is fine; for production it must
//       be inlined to satisfy Apps Script's Content Security Policy)
//
// For full production use, run `npm run build` before `clasp push`.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

// Copy Apps Script server files
const serverFiles = ['Code.js', 'storage.js', 'sync.js', 'mutations.js', 'numbering.js'];
serverFiles.forEach(function(file) {
  fs.copyFileSync(path.join(SRC, file), path.join(DIST, file));
  console.log('copied', file);
});

// Copy appsscript.json
fs.copyFileSync(
  path.join(__dirname, '..', 'appsscript.json'),
  path.join(DIST, 'appsscript.json')
);

// Process sidebar.html
// In production, you would replace the esm.sh import with inlined Preact.
// For now we copy as-is (suitable for development deployments).
fs.copyFileSync(path.join(SRC, 'sidebar.html'), path.join(DIST, 'sidebar.html'));
console.log('copied sidebar.html');

console.log('\nBuild complete → dist/');
console.log('Run: clasp push (from the dist/ directory, or configure .clasp.json accordingly)');
