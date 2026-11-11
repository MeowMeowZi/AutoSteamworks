import type { FieldValue } from './partner/form.js';
import { norm, type Fields } from './local/storeFiles.js';

export type ChangeKind =
  | 'local' //    只有本地改了 → push
  | 'remote' //   只有线上改了 → 需要 pull
  | 'conflict' // 两边都改了且不一样
  | 'gone'; //    本地有，但线上页面已经没有这个字段

export interface Change {
  key: string;
  kind: ChangeKind;
  local?: FieldValue;
  remote?: FieldValue;
  base?: FieldValue;
}

const eq = (a?: FieldValue, b?: FieldValue) =>
  a === undefined || b === undefined ? a === b : norm(a) === norm(b);

/** 本地 / 线上 / 快照 三方对比。本地文件里没有的 key 视为“不管”。 */
export function threeWay(local: Fields, remote: Fields, base: Fields): Change[] {
  const out: Change[] = [];
  for (const key of Object.keys(local).sort()) {
    const l = local[key], r = remote[key], b = base[key];
    if (r === undefined) {
      out.push({ key, kind: 'gone', local: l, base: b });
      continue;
    }
    if (eq(l, r)) continue;
    const localChanged = !eq(l, b);
    const remoteChanged = !eq(r, b);
    const kind: ChangeKind = localChanged && remoteChanged ? 'conflict' : localChanged ? 'local' : 'remote';
    out.push({ key, kind, local: l, remote: r, base: b });
  }
  return out;
}

/** 离线：本地相对快照改了哪些 */
export function localEdits(local: Fields, base: Fields): string[] {
  return Object.keys(local).filter((k) => !eq(local[k], base[k])).sort();
}
