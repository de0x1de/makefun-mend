// main.ts is mend, the CLI SPEC.md specifies. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching
// tiers, and writes every change or none, printing what it changed or why it failed. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---- files and lines (SPEC section 3) ---- */

interface FileLines {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const parts = text.split(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

/* ---- matching lines (SPEC section 5) ---- */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineMatch(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

interface Occ {
  tier: number;
  positions: number[];
}

/** Occurrences of O in fileLines at the first tier that has any, at or after `from`. */
function findOcc(fileLines: string[], O: string[], strict: boolean, from = 0, endAtEnd = false): Occ | null {
  if (O.length === 0) return null;
  for (const tier of tiersToTry(strict)) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= fileLines.length; i += 1) {
      if (endAtEnd && i + O.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (!lineMatch(fileLines[i + j]!, O[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line (also in O) or a fresh line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** The lines that replace the matched ones: context lines are the file's own, tier 2 re-indents the rest. */
function buildWritten(fileLines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const F = leadWS(fileLines[pos]!);
  const P = leadWS(O[0]!);
  return N.map((n) => {
    if (n.ctx) return fileLines[pos + n.oIdx]!;
    if (tier === 2) {
      const t = n.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
      return t;
    }
    return n.text;
  });
}

/** Build O and N from a hunk/chunk body of ' ', '-' and '+' entries ('\\' entries are left out). */
function bodyON(body: BodyEntry[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const e of body) {
    if (e.type === ' ') {
      const oi = O.length;
      O.push(e.text);
      N.push({ text: e.text, ctx: true, oIdx: oi });
    } else if (e.type === '-') {
      O.push(e.text);
    } else if (e.type === '+') {
      N.push({ text: e.text, ctx: false, oIdx: -1 });
    }
  }
  return { O, N };
}

interface BodyEntry {
  type: ' ' | '-' | '+' | '\\';
  text: string;
  rawEmpty: boolean;
}

/* ---- format detection (SPEC section 4) ---- */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---- unified diffs (SPEC section 6) ---- */

interface Hunk {
  a: number;
  body: BodyEntry[];
}

interface Section {
  diffOld: string | undefined;
  diffNew: string | undefined;
  minus: string | null | undefined;
  plus: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newMode: boolean;
  delMode: boolean;
  hunks: Hunk[];
}

function parseDiffPath(raw: string): string | null {
  let t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: Section[] = [];
  let i = 0;
  const isPairStart = (idx: number): boolean => lines[idx]!.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ');
  while (i < n) {
    const line = lines[i]!;
    let sec: Section;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { diffOld: m[1]!, diffNew: m[2]!, minus: undefined, plus: undefined, renameFrom: undefined, renameTo: undefined, newMode: false, delMode: false, hunks: [] };
      i += 1;
    } else if (isPairStart(i)) {
      sec = { diffOld: undefined, diffNew: undefined, minus: undefined, plus: undefined, renameFrom: undefined, renameTo: undefined, newMode: false, delMode: false, hunks: [] };
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
      continue;
    }
    // The section header: everything before its first hunk.
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (sec.minus !== undefined) break;
        sec.minus = parseDiffPath(l.slice(4));
        i += 1;
        continue;
      }
      if (l.startsWith('+++ ')) {
        sec.plus = parseDiffPath(l.slice(4));
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        sec.renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.newMode = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.delMode = true;
        i += 1;
        continue;
      }
      i += 1;
    }
    // The section's hunks.
    while (i < n && lines[i]!.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[i]!);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i += 1;
      const body: BodyEntry[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (isPairStart(i)) break;
        if (l === '') {
          body.push({ type: ' ', text: '', rawEmpty: true });
          i += 1;
        } else if (l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push({ type: l[0] as BodyEntry['type'], text: l.slice(1), rawEmpty: false });
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
      sec.hunks.push({ a, body });
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Apply a section's hunks in order to a file's text; a hunk failure fails the whole section. */
function applyHunks(fileText: string, hunks: Hunk[], strict: boolean, errPath: string): string {
  const f = splitFile(fileText);
  const arr = f.lines.slice();
  let ends = f.ends;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    let lastCtxPlus = -1;
    h.body.forEach((e, idx) => {
      if (e.type === ' ' || e.type === '+') lastCtxPlus = idx;
    });
    const noEol = lastCtxPlus >= 0 && h.body[lastCtxPlus + 1]?.type === '\\';
    if (O.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > arr.length) pos = arr.length;
      const add = N.map((x) => x.text);
      const atEnd = pos === arr.length;
      arr.splice(pos, 0, ...add);
      if (atEnd) ends = !noEol;
      d += add.length;
    } else {
      const occ = findOcc(arr, O, strict);
      if (occ === null) throw new Fail('no-match', errPath);
      const target = h.a - 1 + d;
      let best = occ.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of occ.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const written = buildWritten(arr, best, O, N, occ.tier);
      const runsToEnd = best + O.length === arr.length;
      arr.splice(best, O.length, ...written);
      if (runsToEnd) ends = !noEol;
      d += N.length - O.length;
    }
  }
  return joinFile(arr, f.br, ends);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldPath: string | null | undefined = sec.minus !== undefined ? sec.minus : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newPath: string | null | undefined = sec.plus !== undefined ? sec.plus : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  return (tree) => {
    if (oldPath !== null && oldPath !== undefined && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && newPath !== undefined && newPath !== oldPath && !safe(newPath)) throw new Fail('unsafe', newPath);
    if ((oldPath === null || sec.newMode) && newPath !== null && newPath !== undefined && !(newPath === null && oldPath === null)) {
      // A creation, unless it is really a deletion in disguise.
      if (oldPath === null || (sec.newMode && !sec.delMode)) {
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const pl: string[] = [];
        let noEol = false;
        for (const h of sec.hunks) {
          h.body.forEach((e, idx) => {
            if (e.type === '+') {
              pl.push(e.text);
              noEol = h.body[idx + 1]?.type === '\\';
            }
          });
        }
        tree.now.set(newPath, joinFile(pl, '\n', !noEol));
        return;
      }
    }
    if (newPath === null || sec.delMode) {
      const p = oldPath;
      if (p === null || p === undefined) return;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath === null || oldPath === undefined || newPath === undefined) return;
    if (oldPath !== newPath) {
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = applyHunks(before, sec.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, applyHunks(before, sec.hunks, strict, oldPath));
  };
}

/* ---- SEARCH/REPLACE blocks (SPEC section 7) ---- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(newLines, '\n', true));
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const f = splitFile(t);
    const occ = findOcc(f.lines, oldLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = occ.positions[0]!;
    const N: NLine[] = newLines.map((x) => ({ text: x, ctx: false, oIdx: -1 }));
    const written = buildWritten(f.lines, pos, oldLines, N, occ.tier);
    const arr = f.lines.slice();
    arr.splice(pos, oldLines.length, ...written);
    tree.now.set(path, joinFile(arr, f.br, f.ends));
  };
}

/* ---- V4A patches (SPEC section 8) ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  lineNo: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i += 1) {
    if (!blank(lines[i]!)) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const headerKind = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const headerPath = (l: string, kind: 'add' | 'delete' | 'update'): string => {
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    return l.slice(prefix.length).trim();
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = headerKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = headerPath(l, kind);
    const lineNo = i + 1;
    i += 1;
    const start = i;
    while (i < last && headerKind(lines[i]!) === null) i += 1;
    const raw = lines.slice(start, i).map((text, idx) => ({ text, lineNo: start + idx + 1 }));
    // Blank lines at the end of a section are not part of it (a blank line is empty or only whitespace).
    while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.lineNo}`);
      }
      sections.push({ kind, path, moveTo: null, addLines, chunks: [], lineNo });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.lineNo}`);
      }
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [], lineNo });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
        moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let curOpen = false;
      for (let k = idx; k < raw.length; k += 1) {
        const r = raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          const a = t.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, body: [] };
          chunks.push(cur);
          curOpen = true;
        } else if (t.trim() === '*** End of File') {
          if (cur === null || !curOpen) {
            cur = { anchor: null, eof: true, body: [] };
            chunks.push(cur);
          } else {
            cur.eof = true;
          }
          curOpen = false;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null || !curOpen) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
            curOpen = true;
          }
          if (t === '') cur.body.push({ type: ' ', text: '', rawEmpty: true });
          else cur.body.push({ type: t[0] as BodyEntry['type'], text: t.slice(1), rawEmpty: false });
        } else {
          throw new Exit2(`error: parse ${r.lineNo}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
      sections.push({ kind, path, moveTo, addLines: [], chunks, lineNo });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => v4aEdit(sec, strict));
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, joinFile(sec.addLines, '\n', true));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const t = tree.get(sec.path);
    if (t === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(t);
    const arr = f.lines.slice();
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const tier of tiersToTry(strict)) {
          for (let p = cursor; p < arr.length; p += 1) {
            if (lineMatch(arr[p]!, ch.anchor, tier)) {
              found = p;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? arr.length : Math.min(cursor, arr.length);
        const add = N.map((x) => x.text);
        arr.splice(pos, 0, ...add);
        cursor = pos + add.length;
      } else {
        const occ = findOcc(arr, O, strict, cursor, ch.eof);
        if (occ === null) throw new Fail('no-match', sec.path);
        const pos = occ.positions[0]!;
        const written = buildWritten(arr, pos, O, N, occ.tier);
        arr.splice(pos, O.length, ...written);
        cursor = pos + written.length;
      }
    }
    const out = joinFile(arr, f.br, f.ends);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/* ---- JSON edits (SPEC section 9) ---- */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const arr = f.lines.slice();
      arr.splice(line, 0, ...add);
      tree.now.set(p, joinFile(arr, f.br, f.ends));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- the command line, output and atomicity (SPEC sections 1, 2 and 10) ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A successful move whose old path is gone and whose new path is new prints as one R line, sorted by the new path.
  const moveNewToOld = new Map<string, string>();
  for (const [o, nw] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(nw) === null && tree.now.get(nw) !== null) moveNewToOld.set(nw, o);
  }
  const movedOlds = new Set(moveNewToOld.values());
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveNewToOld.has(p)) rows.push({ key: p, line: `R ${moveNewToOld.get(p)!} -> ${p}` });
    else if (!movedOlds.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
