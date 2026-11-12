// App 文本状态：一个 App 的本地商店文本、上次同步的快照、本地改动、规则检查，以及网页上每个字段的视图。
// status / check / 网页都只从这里取，不要自己读快照、比较字段或判断“拉取过没有”。
import { diffChars, diffLines } from 'diff';
import type { AppConfig, Config } from './config.js';
import type { FieldValue } from './partner/form.js';
import { hasLocal, norm, readLocal, readSnapshot, splitLocalized, type Fields } from './local/storeFiles.js';
import { lint, type LintIssue } from './lint.js';
import { localEdits, type Change, type ChangeKind } from './sync.js';
import { describeField, fieldShape, type FieldInfo, type FieldShape } from './fieldInfo.js';

export interface TextState {
  /** 本地文件和快照都有才算拉取过 */
  pulled: boolean;
  /** 本地有商店文本文件（可能是手写的，没有快照） */
  hasLocal: boolean;
  local: Fields;
  /** 上次同步时的快照；没有快照时算不出改动 */
  base?: Fields;
  /** 本地相对快照改了哪些字段；没有快照时为空 */
  edits: string[];
  /** 规则检查（只要有本地文件就检查） */
  issues: LintIssue[];
}

export function readTextState(c: Config, app: AppConfig): TextState {
  const has = hasLocal(app);
  const local = has ? readLocal(app) : {};
  const base = readSnapshot(c, app);
  return {
    pulled: has && !!base,
    hasLocal: has,
    local,
    base,
    edits: base ? localEdits(local, base) : [],
    issues: has ? lint(app, local) : [],
  };
}

/** 文本差异片段，网页上用来高亮：t = 1 新加，-1 删掉，0 不变 */
export interface DiffPart { v: string; t: 1 | -1 | 0 }

function diffParts(from: FieldValue | undefined, to: FieldValue | undefined): DiffPart[] | undefined {
  if (typeof from !== 'string' || typeof to !== 'string') return undefined;
  const a = norm(from) as string, b = norm(to) as string;
  const d = a.length + b.length < 8000 ? diffChars(a, b) : diffLines(a, b);
  return d.map((p) => ({ v: p.value, t: p.added ? 1 : p.removed ? -1 : 0 }));
}

export interface FieldView {
  key: string;
  local: FieldValue;
  base?: FieldValue;
  /** 本地相对快照改过 */
  edited: boolean;
  info: FieldInfo;
  /** 本地化字段的语言 */
  lang?: string;
  shape: FieldShape;
  /** 相对快照的差异（改过的文本字段才有） */
  parts?: DiffPart[];
  /** 最近一次和线上对比时，这个字段的差别 */
  remote?: { kind: ChangeKind; value?: FieldValue; parts?: DiffPart[] };
}

export interface TextView {
  /** 和语言无关的字段 */
  common: FieldView[];
  /** 本地化字段：一行 = 一个 path，各语言并排 */
  localized: { path: string; langs: Record<string, FieldView> }[];
  /** 线上有、但本地没改的变化（本地改了的已经挂在字段上） */
  remoteOnly: string[];
}

/**
 * 网页上的字段视图。
 * remote：最近一次和线上对比的结果（没有对比过就不传）；labels：从后台页面读到的复选框文字
 */
export function textView(s: TextState, remote?: Map<string, Change>, labels?: Record<string, string>): TextView {
  const edits = new Set(s.edits);
  const has = (k: string) => k in s.local;
  const common: FieldView[] = [];
  const byPath = new Map<string, Record<string, FieldView>>();
  for (const key of Object.keys(s.local).sort()) {
    const l = s.local[key], b = s.base?.[key];
    const edited = edits.has(key);
    const r = remote?.get(key);
    const loc = splitLocalized(key);
    const v: FieldView = {
      key, local: l, base: b, edited,
      info: describeField(key, labels?.[key.replace(/\[=.*\]$/, '')]),
      lang: loc?.lang,
      shape: fieldShape(key, has),
      parts: edited ? diffParts(b, l) : undefined,
      remote: r && { kind: r.kind, value: r.remote, parts: diffParts(r.remote, l) },
    };
    if (!loc) { common.push(v); continue; }
    const row = byPath.get(loc.path) ?? {};
    row[loc.lang] = v;
    byPath.set(loc.path, row);
  }
  return {
    common,
    localized: [...byPath].map(([path, langs]) => ({ path, langs })),
    remoteOnly: remote ? [...remote.values()].filter((ch) => ch.kind === 'remote').map((ch) => ch.key) : [],
  };
}
