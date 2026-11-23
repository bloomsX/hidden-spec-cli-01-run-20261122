// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output
// and exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/* ------------------------------------------------------------------ file model (section 3) */

function fileBreak(text: string): string {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const br = fileBreak(text);
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/* ------------------------------------------------------------- matching (section 5) */

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return stripTrail(s).replace(/^[ \t]+/, '');
}

function matchAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

interface Found {
  tier: number;
  occ: number[];
}

/** First tier (0, 1, 2; 0 only with --strict) at which O occurs in lines at or after `from`, and every such
 *  occurrence. With eofOnly only occurrences ending at the file's last line count. O must be non-empty. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      if (eofOnly && i + o.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < o.length; k++) {
        if (!matchAt(lines[i + k]!, o[k]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) occ.push(i);
    }
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** A line of N that is not a context line: at tier 2, with F the leading spaces/tabs of the file's first matched
 *  line and P those of O's first line, a non-blank line starting with P has P replaced by F. */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One line of N: a context line keeps the index of its line in O (written as the file's own matched line), a new
 *  line keeps its patch text. */
interface NLine {
  text: string;
  oIdx: number | null;
}

/** Map N onto the file: context lines become the file's matched lines, other lines are re-indented at tier 2. */
function mapNew(n: NLine[], lines: string[], at: number, tier: number, o: string[]): string[] {
  const f = leadWs(lines[at]!);
  const p = leadWs(o[0]!);
  return n.map((x) => {
    if (x.oIdx !== null) return lines[at + x.oIdx]!;
    if (tier === 2) return reindent(x.text, f, p);
    return x.text;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** A move that fully succeeded, for the R rows of section 2. */
interface Move {
  old: string;
  new: string;
}

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/* ------------------------------------------------------------ unified diffs (section 6) */

interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  o: string[];
  n: NLine[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/')) return raw.slice(2);
  if (raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function splitHunkBody(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, oIdx: o.length - 1 });
    } else if (b.kind === 'del') {
      o.push(b.text);
    } else if (b.kind === 'add') {
      n.push({ text: b.text, oIdx: null });
    }
  }
  return { o, n };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function bsAfterLastCtxOrAdd(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === 'ctx' || b.kind === 'add') return body[k + 1]?.kind === 'bs';
  }
  return false;
}

/** A created file ends with a line break unless a `\` line follows its last `+` line. */
function creationFinalBreak(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === 'add') return body[k + 1]?.kind !== 'bs';
    }
  }
  return true;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  const fresh = (diffOld: string | null, diffNew: string | null): Section => ({
    diffOld,
    diffNew,
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = fresh(m[1]!, m[2]!);
      sections.push(sec);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && sec.hunks.length === 0 && !sec.hasPair) {
        sec.hasPair = true;
        sec.pairOld = headerPath(l);
        sec.pairNew = headerPath(lines[i + 1]!);
      } else {
        sec = fresh(null, null);
        sec.hasPair = true;
        sec.pairOld = headerPath(l);
        sec.pairNew = headerPath(lines[i + 1]!);
        sections.push(sec);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: BodyLine[] = [];
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') body.push({ kind: 'ctx', text: '', raw: b });
        else if (b[0] === ' ') body.push({ kind: 'ctx', text: b.slice(1), raw: b });
        else if (b[0] === '-') body.push({ kind: 'del', text: b.slice(1), raw: b });
        else if (b[0] === '+') body.push({ kind: 'add', text: b.slice(1), raw: b });
        else if (b[0] === '\\') body.push({ kind: 'bs', text: b, raw: b });
        else break;
        j++;
      }
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      const { o, n } = splitHunkBody(body);
      sec.hunks.push({ a: Number(m[1]), body, o, n });
      i = j;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (sec !== null && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (l.startsWith('new file mode')) sec.newFile = true;
      else if (l.startsWith('deleted file mode')) sec.deletedFile = true;
      else if (l.startsWith('rename from ')) sec.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice('rename to '.length).trim();
    }
    i++;
  }
  return sections;
}

function unifiedCreateEdit(newP: string, hunks: Hunk[]): Edit {
  return (tree) => {
    if (!safe(newP)) throw new Fail('unsafe', newP);
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
    const plus: string[] = [];
    for (const h of hunks) for (const b of h.body) if (b.kind === 'add') plus.push(b.text);
    tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (creationFinalBreak(hunks) ? '\n' : ''));
  };
}

function unifiedDeleteEdit(oldP: string): Edit {
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, null);
  };
}

function unifiedChangeEdit(oldP: string, newP: string | null, hunks: Hunk[], strict: boolean, moves: Move[]): Edit {
  const isMove = newP !== null && newP !== oldP;
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP!)) throw new Fail('unsafe', newP!);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const f = splitFile(before);
    let lines = f.lines;
    let finalBr = f.final;
    const br = f.br;
    let d = 0;
    for (const hunk of hunks) {
      if (hunk.o.length === 0) {
        const p = Math.min(Math.max(hunk.a + d, 0), lines.length);
        const ins = hunk.n.map((x) => x.text);
        const atEnd = p === lines.length;
        lines = [...lines.slice(0, p), ...ins, ...lines.slice(p)];
        if (atEnd) finalBr = !bsAfterLastCtxOrAdd(hunk.body);
        d += hunk.n.length;
      } else {
        const found = findTier(lines, hunk.o, strict);
        if (found === null) throw new Fail('no-match', oldP);
        const target = hunk.a - 1 + d;
        let best = found.occ[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of found.occ) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const atEnd = best + hunk.o.length === lines.length;
        const mapped = mapNew(hunk.n, lines, best, found.tier, hunk.o);
        lines = [...lines.slice(0, best), ...mapped, ...lines.slice(best + hunk.o.length)];
        if (atEnd) finalBr = !bsAfterLastCtxOrAdd(hunk.body);
        d += hunk.n.length - hunk.o.length;
      }
    }
    const out = joinFile(lines, br, finalBr);
    if (isMove) {
      tree.now.set(newP!, out);
      tree.now.set(oldP, null);
      moves.push({ old: oldP, new: newP! });
    } else {
      tree.now.set(oldP, out);
    }
  };
}

function unifiedSectionEdit(sec: Section, strict: boolean, moves: Move[]): Edit {
  const oldP = sec.hasPair ? sec.pairOld : sec.renameFrom ?? sec.diffOld;
  const newP = sec.hasPair ? sec.pairNew : sec.renameTo ?? sec.diffNew;
  if ((oldP === null || sec.newFile) && newP !== null) return unifiedCreateEdit(newP, sec.hunks);
  if ((newP === null || sec.deletedFile) && oldP !== null) return unifiedDeleteEdit(oldP);
  if (oldP !== null && newP !== null) return unifiedChangeEdit(oldP, oldP === newP ? null : newP, sec.hunks, strict, moves);
  return () => {};
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  return parseUnified(lines).map((sec) => unifiedSectionEdit(sec, strict, moves));
}

/* ----------------------------------------------------- SEARCH/REPLACE blocks (section 7) */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const mapped = newLines.map((t) => (found.tier === 2 ? reindent(t, leadWs(f.lines[at]!), leadWs(oldLines[0]!)) : t));
    const out = [...f.lines.slice(0, at), ...mapped, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile(out, f.br, f.final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ---------------------------------------------------------------- V4A patches (section 8) */

interface VLine {
  text: string;
  num: number;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

function v4aAddEdit(path: string, body: VLine[]): Edit {
  const out: string[] = [];
  for (const l of body) {
    if (l.text === '') out.push('');
    else if (l.text.startsWith('+')) out.push(l.text.slice(1));
    else throw new Exit2(`error: parse ${l.num}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, out.length === 0 ? '' : out.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string, body: VLine[]): Edit {
  for (const l of body) throw new Exit2(`error: parse ${l.num}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function buildVChunk(anchor: string | null, eof: boolean, body: VLine[]): VChunk {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l.text === '' || l.text[0] === ' ') {
      const t = l.text === '' ? '' : l.text.slice(1);
      o.push(t);
      n.push({ text: t, oIdx: o.length - 1 });
    } else if (l.text[0] === '-') {
      o.push(l.text.slice(1));
    } else if (l.text[0] === '+') {
      n.push({ text: l.text.slice(1), oIdx: null });
    }
  }
  return { anchor, eof, o, n };
}

function v4aUpdateEdit(path: string, body: VLine[], updateLine: number, strict: boolean, moves: Move[]): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
    moveTo = body[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: VLine[] } | null = null;
  const flush = (): void => {
    if (cur !== null) {
      chunks.push(buildVChunk(cur.anchor, cur.eof, cur.body));
      cur = null;
    }
  };
  for (; idx < body.length; idx++) {
    const l = body[idx]!;
    if (l.text.startsWith('@@')) {
      flush();
      cur = { anchor: l.text.slice(2).trim() || null, eof: false, body: [] };
    } else if (l.text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${l.num}`);
      cur.eof = true;
      flush();
    } else if (l.text === '' || l.text[0] === ' ' || l.text[0] === '-' || l.text[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${l.num}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push(l);
    } else {
      throw new Exit2(`error: parse ${l.num}`);
    }
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(lines, [ch.anchor], strict, cursor, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      if (ch.o.length === 0) {
        const p = ch.eof ? lines.length : cursor;
        const ins = ch.n.map((x) => x.text);
        lines = [...lines.slice(0, p), ...ins, ...lines.slice(p)];
        cursor = p + ins.length;
      } else {
        const found = findTier(lines, ch.o, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const at = found.occ[0]!;
        const mapped = mapNew(ch.n, lines, at, found.tier, ch.o);
        lines = [...lines.slice(0, at), ...mapped, ...lines.slice(at + ch.o.length)];
        cursor = at + mapped.length;
      }
    }
    const out = joinFile(lines, f.br, f.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

const V4A_SECTION = /^\*\*\* (Add|Delete|Update) File: (.*)$/;

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const m = V4A_SECTION.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const startLine = i + 1;
    const body: VLine[] = [];
    let j = i + 1;
    while (j < last) {
      if (V4A_SECTION.test(lines[j]!)) break;
      body.push({ text: lines[j]!, num: j + 1 });
      j++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (kind === 'Add') edits.push(v4aAddEdit(path, body));
    else if (kind === 'Delete') edits.push(v4aDeleteEdit(path, body));
    else edits.push(v4aUpdateEdit(path, body, startLine, strict, moves));
    i = j;
  }
  return edits;
}

/* ------------------------------------------------------------------ the run (sections 1, 2, 10) */

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
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byPath = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    byPath.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const extra: { key: string; text: string }[] = [];
  for (const mv of moves) {
    const oldWas = tree.original(mv.old);
    const oldNow = tree.get(mv.old);
    const newWas = tree.original(mv.new);
    const newNow = tree.get(mv.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      byPath.delete(mv.old);
      byPath.delete(mv.new);
      extra.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
    }
  }
  const rows = [...[...byPath.entries()].map(([p, text]) => ({ key: p, text })), ...extra]
    .sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')))
    .map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
