// 图片页的数据：按后台的槽位（形象图片、小宣传图…）× 语言排成表，每格写清楚本地有什么、后台有什么、该做什么。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, Config } from '../config.js';
import { assetState, readManifest, type AssetState, type LocalAsset } from '../local/assetFiles.js';
import { ANY_LANG, cellKey, cellName, cellOf, filesIn, remoteLang, scanCells } from '../local/imageCells.js';
import { INBOX, planInbox } from '../local/inbox.js';
import type { RemoteMeta } from '../partner/meta.js';
import { remotePath, remoteScreenshotCount, SLOTS, type Slot } from '../slots.js';
import { LANG_NAMES } from '../fieldInfo.js';

export type CellStatus = 'pending' | 'synced' | 'uploaded' | 'lost' | 'remote-only' | 'missing-required' | 'fallback' | 'empty';

export interface LocalImage { rel: string; state: AssetState; bytes: number; size?: string; uploadedAt?: string }

export interface Cell {
  /** 格子的 key，例如 "header|schinese"（见 local/imageCells.ts）；网页拖拽、删除都用它 */
  key: string;
  /** 给人看的位置名，例如 “形象图片（简体中文）” */
  name: string;
  status: CellStatus;
  /** 给人看的一句话 */
  text: string;
  local?: LocalImage;
  /** 同一个格子里多出来的本地文件（只会上传其中一张） */
  extra: string[];
  remoteUrl?: string;
}

export interface SlotRow extends Slot {
  /** key 是语言；不分语言的槽位用 '*' */
  cells: Record<string, Cell>;
}

export interface Issue { level: 'error' | 'warn'; msg: string }

const STATUS_TEXT: Record<CellStatus, string> = {
  pending: '待上传',
  synced: '已在后台',
  uploaded: '已上传（还没核对后台，点“刷新后台状态”）',
  lost: '上传过，但后台现在没有（可能在后台被删了）',
  'remote-only': '只在后台，本地没有这张图',
  'missing-required': '缺少（必填）',
  fallback: '没有单独的图，商店会显示英文版',
  empty: '未设置',
};

export function imageBoard(c: Config, app: AppConfig, meta: RemoteMeta | undefined) {
  // 旧项目没有收件箱：打开网页时顺手建好，用户能直接往里丢图片
  mkdirSync(join(app.assets.dir, INBOX), { recursive: true });
  const scan = scanCells(app);
  const manifest = readManifest(c, app);
  const cdn = meta?.cdnBase ?? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${app.appid}/`;
  const issues: Issue[] = scan.warnings.map((msg) => ({ level: 'warn', msg }));
  const image = (a: LocalAsset & { size?: string }): LocalImage => ({
    rel: a.rel, state: assetState(a, manifest), bytes: a.bytes.length, size: a.size, uploadedAt: manifest[a.rel]?.uploadedAt,
  });
  const unmatched = scan.unmatched.map((u) => ({ ...image(u), reason: u.reason }));
  const screenshots = scan.screenshots.map(image);

  const slots: SlotRow[] = SLOTS.filter((s) => s.tab !== 'screenshot').map((slot) => {
    const langs = slot.localized ? app.languages : [ANY_LANG];
    const cells: Record<string, Cell> = {};
    for (const lang of langs) {
      const cell = cellOf(slot, lang);
      const [local, ...more] = filesIn(scan, cell).map(image);
      const path = remotePath(meta?.assets, slot, remoteLang(cell));
      let status: CellStatus;
      if (local) {
        status = local.state !== 'same' ? 'pending' : !meta ? 'uploaded' : path ? 'synced' : 'lost';
      } else if (path) {
        status = 'remote-only';
      } else if (slot.required) {
        status = lang === 'english' ? 'missing-required' : 'fallback';
      } else {
        status = 'empty';
      }
      let text = STATUS_TEXT[status];
      if (local && local.state === 'changed') text = '本地改过，待上传（会替换后台的图）';
      if (local && local.state === 'new' && path) text = '待上传（会替换后台现在的图）';
      cells[lang] = { key: cellKey(cell), name: cellName(cell, (l) => LANG_NAMES[l] ?? l), status, text, local, extra: more.map((m) => m.rel), remoteUrl: path ? cdn + path : undefined };
      if (more.length) issues.push({ level: 'warn', msg: `${cells[lang].name} 有 ${more.length + 1} 张本地图片：${[local!.rel, ...more.map((m) => m.rel)].join('、')}。后台每个位置只能放一张，只保留一张。` });
    }
    return { ...slot, cells };
  });

  const missing = slots.filter((s) => s.cells.english?.status === 'missing-required').map((s) => s.label);
  if (missing.length && app.languages.includes('english')) {
    issues.unshift({ level: 'error', msg: `必填的宣传图还没有英文版：${missing.join('、')}。Steam 要求每张必填图都有英文版，其他语言没有单独的图时也会显示英文版。` });
  }
  for (const u of unmatched) issues.push({ level: 'error', msg: `${u.rel}：${u.reason}` });

  return {
    cdnKnown: !!meta?.cdnBase,
    slots,
    screenshots: { local: screenshots, remoteCount: remoteScreenshotCount(meta?.assets), where: SLOTS.find((s) => s.id === 'screenshot')!.where },
    unmatched,
    issues,
    /** 待分类里的图片和各自会去的位置 */
    inbox: { dir: INBOX, items: planInbox(app) },
    pending: [...slots.flatMap((s) => Object.values(s.cells)).filter((x) => x.status === 'pending').map((x) => x.local!.rel),
      ...screenshots.filter((s) => s.state !== 'same').map((s) => s.rel)],
  };
}
