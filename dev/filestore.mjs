// Local-dev store: the in-memory store from api/_lib/store.mjs, persisted to a JSON file after every
// write so bug reports and published menus survive a server restart. Never deployed.
import fs from 'node:fs';
import path from 'node:path';
import { memoryStore } from '../api/_lib/store.mjs';

export function fileStore(file) {
  let entries = {};
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run, or unreadable: start empty */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const save = (map) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 1));
    fs.renameSync(tmp, file);   // atomic: a crash mid-write never leaves a half-written store
  };
  return { ...memoryStore({ entries, onChange: save }), kind: 'file' };
}
