// 添加 Demo：写进配置（config.ts 的 addDemoApp），再把正式版本地的“关联的 Demo”填上。网页“设置 → Demo”用它。
import { addDemoApp, loadConfig, selectApps, type NewDemo } from './config.js';
import { hasLocal, readLocal, writeLocalField } from './local/storeFiles.js';

/** 正式版商店页上“关联的 Demo”（第一个），值是 Demo 的 itemid（不是 appid） */
export const RELATED_DEMO = 'app[related_items][demos][0][itemid]';

/** 返回新 App 的 key 和给人看的结果说明 */
export function addDemo(configPath: string, parentKey: string, d: NewDemo): { key: string; lines: string[] } {
  const [parent] = selectApps(loadConfig(configPath), [parentKey]);
  const itemid = Number(d.itemid);
  const key = addDemoApp(configPath, parent.key, { ...d, itemid });
  const lines = [`✓ 已添加 Demo：${key}（App ID ${d.appid}）。文本和图片没有单独设置的都跟随 ${parent.key}`];
  // 只改本地，上传正式版文本时能在预览里看到
  const local = hasLocal(parent) ? readLocal(parent) : {};
  if (local[RELATED_DEMO] === '') {
    writeLocalField(parent, RELATED_DEMO, String(itemid));
    lines.push(`✓ ${parent.key} 的“关联的 Demo”填上了 ${itemid}（只改了本地，上传 ${parent.key} 的文本时传到后台）`);
  } else if (!(RELATED_DEMO in local)) {
    lines.push(`ℹ ${parent.key} 本地还没有“关联的 Demo”字段（先拉取 ${parent.key}），之后在 ${parent.key} 的文本里填上 ${itemid}`);
  } else if (String(local[RELATED_DEMO]) !== String(itemid)) {
    lines.push(`ℹ ${parent.key} 的“关联的 Demo”已经是 ${local[RELATED_DEMO]}，没有改`);
  }
  lines.push(`下一步：在左边选中 ${key}，点“拉取”`);
  return { key, lines };
}
