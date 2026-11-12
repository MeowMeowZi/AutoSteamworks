// 同步计划：决定要对后台做什么、做完后本地记录怎么更新。全是纯函数，不碰浏览器，也不读写文件。
// ops.ts 负责：读本地文件 / 快照 / 上传记录 → 调这里算计划 → 去后台执行 → 用这里算出的新记录写回去 → 打日志。
import type { FieldValue } from './partner/form.js';
import type { AssetResult } from './partner/assets.js';
import type { AppConfig } from './config.js';
import type { Fields } from './local/storeFiles.js';
import { localEdits, threeWay, type Change } from './sync.js';
import { supportedLanguages } from './partner/store.js';
import { assetState, type AssetManifest, type AssetState } from './local/assetFiles.js';
import { filesIn, parseCell, type Cell, type CellFile, type CellScan } from './local/imageCells.js';

// ---- 拉取 ----

/** 拉取前：本地相对快照有改动时不能覆盖（除非 force）。返回挡住拉取的改动（空 = 可以拉） */
export function pullBlockers(local: Fields | undefined, base: Fields | undefined, force?: boolean): string[] {
  if (!local || !base || force) return [];
  return localEdits(local, base);
}

/** 后台“支持的语言”里勾了、本地还没同步的语言 */
export const newLanguages = (remoteAll: Fields, languages: string[]) =>
  supportedLanguages(remoteAll).filter((l) => !languages.includes(l));

// ---- 推送文本 ----

export interface PushPlan {
  /** 三方对比结果（已按 only 过滤） */
  changes: Change[];
  /** 要写到后台的字段 */
  toPush: Change[];
}

export function planPush(local: Fields, remote: Fields, base: Fields, o: { only?: string[]; force?: boolean }): PushPlan {
  let changes = threeWay(local, remote, base);
  if (o.only) changes = changes.filter((ch) => o.only!.includes(ch.key));
  const toPush = changes.filter((ch) => ch.kind === 'local' || (o.force && ch.kind === 'conflict'));
  return { changes, toPush };
}

export const pushEntries = (p: PushPlan): [string, FieldValue][] => p.toPush.map((ch) => [ch.key, ch.local!]);

/** 推送后的快照：只把成功保存的字段更新成后台的新值；其他字段保持原来的基准，否则会误把线上改动当成本地改动 */
export function snapshotAfterPush(base: Fields, saved: string[], after: Fields): Fields {
  const snap = { ...base };
  for (const k of saved) snap[k] = after[k];
  return snap;
}

// ---- 上传图片 ----

export interface UploadItem { file: CellFile; state: AssetState }

export interface AssetsPlan {
  /** 本地能识别位置的图片数（不含 rejected） */
  total: number;
  todo: UploadItem[];
  /** 尺寸不对、读不出尺寸的图：不上传，直接算失败 */
  rejected: { rel: string; reason: string }[];
  /** 整个计划不能执行的原因 */
  error?: string;
}

const TAB_ORDER = ['store', 'library', 'screenshot'];

/** 和网页图片表用同一份扫描（scanCells），网页上的“待上传”就是这里的 todo */
export function planAssets(scan: CellScan, manifest: AssetManifest, o: { only?: string[]; force?: boolean; allAges?: boolean }): AssetsPlan {
  const pick = (rel: string) => !o.only || o.only.includes(rel);
  const files = [...[...scan.cells.values()].flat(), ...scan.screenshots]
    .sort((a, b) => TAB_ORDER.indexOf(a.tab) - TAB_ORDER.indexOf(b.tab) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const todo = files.map((file) => ({ file, state: assetState(file, manifest) }))
    .filter((it) => (o.only ? pick(it.file.rel) : o.force || it.state !== 'same'));
  const rejected = scan.unmatched.filter((u) => pick(u.rel)).map((u) => ({ rel: u.rel, reason: u.reason }));
  const plan: AssetsPlan = { total: files.length, todo, rejected };
  if (todo.some((it) => it.file.tab === 'screenshot') && o.allAges === undefined) {
    plan.error = '有截图要上传，但配置里没设置 assets.screenshotsAllAges（Steam 要求声明截图是否适合所有年龄）';
  }
  return plan;
}

/** 上传后的上传记录：成功的记下哈希，失败的不动（下次会重试） */
export function manifestAfterUpload(manifest: AssetManifest, todo: UploadItem[], results: AssetResult[], now: string): AssetManifest {
  const m = { ...manifest };
  results.forEach((r, i) => {
    if (r.ok) m[todo[i].file.rel] = { hash: todo[i].file.hash, type: r.type, uploadedAt: now };
  });
  return m;
}

// ---- 删除后台图片 ----

export interface DeletePlan {
  cells: Cell[];
  errors: { target: string; msg: string }[];
}

/** targets 是格子 key（"header|schinese"、"page_background|*"） */
export function planDelete(app: AppConfig, targets: string[]): DeletePlan {
  const plan: DeletePlan = { cells: [], errors: [] };
  for (const t of targets) {
    try {
      const cell = parseCell(app, t);
      if (cell.slot.tab === 'screenshot') throw new Error('截图暂不支持删除');
      plan.cells.push(cell);
    } catch (e: any) { plan.errors.push({ target: t, msg: e.message }); }
  }
  return plan;
}

/** 后台删掉一格后：清掉这一格本地图片的上传记录，网页上会显示“待上传”而不是“已在后台”。返回新记录和被清掉的文件 */
export function clearCellRecords(manifest: AssetManifest, scan: CellScan, cell: Cell): { manifest: AssetManifest; cleared: string[] } {
  const cleared = filesIn(scan, cell).map((f) => f.rel).filter((rel) => manifest[rel]);
  const m = { ...manifest };
  for (const rel of cleared) delete m[rel];
  return { manifest: m, cleared };
}
