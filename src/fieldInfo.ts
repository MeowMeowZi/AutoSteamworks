// 把表单字段名翻译成后台上看到的位置和名字，网页按这个分组显示。
// 页签和名字来自 2026-11-11 对真实编辑页的探查（.autosw/inspect/field-labels.json）；
// 复选框的文字在拉取时从页面读（RemoteMeta.labels），这里只是兜底。
import { splitLocalized } from './local/storeFiles.js';

export interface FieldInfo {
  /** 后台的页签 */
  tab: string;
  /** 页签里的分组 */
  group: string;
  label: string;
  /** 常用、值得放在前面的字段 */
  primary?: boolean;
}

export const TABS = ['描述', '基本信息', '抢先体验', '特别设置', '其他'];

export const LANG_NAMES: Record<string, string> = {
  english: '英语', schinese: '简体中文', tchinese: '繁体中文', japanese: '日语', koreana: '韩语', thai: '泰语',
  arabic: '阿拉伯语', indonesian: '印度尼西亚语', malay: '马来语', bulgarian: '保加利亚语', czech: '捷克语', danish: '丹麦语',
  german: '德语', spanish: '西班牙语（西班牙）', latam: '西班牙语（拉美）', greek: '希腊语', french: '法语', italian: '意大利语',
  hungarian: '匈牙利语', dutch: '荷兰语', norwegian: '挪威语', polish: '波兰语', portuguese: '葡萄牙语（葡萄牙）',
  brazilian: '葡萄牙语（巴西）', romanian: '罗马尼亚语', russian: '俄语', finnish: '芬兰语', swedish: '瑞典语',
  turkish: '土耳其语', vietnamese: '越南语', ukrainian: '乌克兰语',
};
const lang = (l: string) => LANG_NAMES[l] ?? l;

const OS: Record<string, string> = { windows: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android' };
const REQ: Record<string, string> = { min: '最低配置', rec: '推荐配置' };
const SYSREQ: Record<string, string> = {
  osversion: '操作系统', processor: '处理器', graphics: '显卡', soundcard: '声卡', notes: '附注事项', vrsupport: 'VR 设备和支持',
  memory: '内存', diskspace: '存储空间', directx: 'DirectX', broadband: '网络', amount: '数值', units: '单位',
};
const EARLY_ACCESS: Record<string, string> = {
  why: '为何要采用抢先体验这种模式？',
  how_long: '这款游戏的抢先体验状态大约持续多久？',
  full_version: '计划中的完整版将与抢先体验版有什么不同？',
  current_state: '抢先体验版本的现状如何？',
  pricing: '在抢先体验期间和结束之后，游戏价格会有所不同吗？',
  community: '您计划如何使社区参与到开发进程中？',
};
const LINKS: Record<string, string> = {
  website: '官方网站', privacy_policy: '隐私政策 URL', online_manual: '在线手册 URL', health_warning: '健康警告 URL',
  discord_server: 'Discord', facebook: 'Facebook', twitter: 'X (Twitter)', youtube: 'YouTube', twitch: 'Twitch',
  forums: '论坛', stats: '统计数据页面', steam_deck_blog_url: 'Steam Deck 兼容性信息',
};

/** 本地化字段（按 splitLocalized 得到的 path） */
function localized(path: string): FieldInfo {
  const p = path.split('.');
  if (path === 'short_description') return { tab: '描述', group: '商店文本', label: '简短描述', primary: true };
  if (path === 'about') return { tab: '描述', group: '商店文本', label: '关于此游戏', primary: true };
  if (p[0] === 'sections') {
    const n = Number(p[1]) + 1;
    return { tab: '描述', group: `自定义区块 ${n}`, label: p[2] === 'label' ? '标题' : p[2] === 'content' ? '内容' : p.slice(2).join('.'), primary: true };
  }
  if (path === 'awards.short') return { tab: '描述', group: '奖项与评测', label: '奖项' };
  if (p[0] === 'reviews') return { tab: '描述', group: '奖项与评测', label: `评测 ${Number(p[1]) + 1} 的引语` };
  if (path === 'legal') return { tab: '基本信息', group: '法律信息', label: '版权和商标声明', primary: true };
  if (p[0] === 'earlyaccess') return { tab: '抢先体验', group: '抢先体验问答', label: EARLY_ACCESS[p[1]] ?? p[1], primary: true };
  if (p[0] === 'sysreqs') {
    return { tab: '基本信息', group: `系统需求 · ${OS[p[1]] ?? p[1]} · ${REQ[p[2]] ?? p[2]}`, label: p.slice(3).map((x) => SYSREQ[x] ?? x).join(' · ') };
  }
  if (path === 'app.broadcast.title_custom') return { tab: '特别设置', group: '直播', label: '自定义直播标题' };
  return { tab: '其他', group: '其他本地化字段', label: path };
}

/** 和语言无关的字段 */
function common(key: string, scraped?: string): FieldInfo {
  const parts = key.replace(/\[=.*\]$/, '').replace(/#\d+$/, '').split(/\]\[|\[|\]/).filter(Boolean);
  const [root, a, b, c, d] = parts;
  const s = scraped;
  if (key === 'app[name]') return { tab: '基本信息', group: '基本', label: '产品名称', primary: true };
  if (key === 'app[type]') return { tab: '基本信息', group: '基本', label: '产品类型' };
  if (root === 'app' && a === 'game' && ['developers', 'publishers', 'franchises'].includes(b))
    return { tab: '基本信息', group: '基本', label: { developers: '开发者', publishers: '发行商', franchises: '系列' }[b]!, primary: true };
  if (root === 'app' && a === 'game' && b === 'metacritic') return { tab: '基本信息', group: '基本', label: 'Metacritic 条目' };
  if (root === 'app' && a === 'game' && b?.startsWith('3p')) return { tab: '基本信息', group: '第三方 DRM / 账号 / 反作弊', label: `${b} · ${c}` };
  if (root === 'app' && a === 'content' && b === 'links') return { tab: '基本信息', group: '链接', label: LINKS[c] ?? c, primary: c === 'website' };
  if (root === 'app' && a === 'content' && b === 'support_info')
    return { tab: '基本信息', group: '客服信息', label: { email: '客服邮箱', phone: '客服电话', url: '客服网址' }[c] ?? c };
  if (root === 'app' && a === 'platforms') return { tab: '基本信息', group: '平台', label: s || ({ win: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android' }[b] ?? b) };
  if (root === 'app' && a === 'content' && b === 'supported_languages')
    return { tab: '基本信息', group: '支持语言', label: `${lang(c)} · ${s || ({ supported: '界面', full_audio: '完全音频', subtitles: '字幕' }[d] ?? d)}` };
  if (key === 'additional_languages') return { tab: '基本信息', group: '支持语言', label: '追加语言（下拉框）' };
  if (root === 'app' && a === 'content' && b === 'sysreqs')
    return { tab: '基本信息', group: `系统需求 · ${OS[c] ?? c} · ${REQ[d] ?? d}`, label: parts.slice(5).map((x) => SYSREQ[x] ?? x).join(' · ') };
  if (key === 'app[classification][primary_genre]') return { tab: '基本信息', group: '类型与功能', label: '主要类型', primary: true };
  if (root === 'rgGenres') return { tab: '基本信息', group: '类型与功能', label: s ? `类型：${s}` : `类型 #${a}` };
  if (root === 'app' && a === 'classification' && b === 'category') return { tab: '基本信息', group: '类型与功能', label: s ? `功能：${s}` : `功能 ${c}` };
  if (root === 'tags') return { tab: '基本信息', group: '类型与功能', label: '标签' };
  if (root === 'app' && a === 'content' && /wizard$|keyboardmouse/.test(b)) return { tab: '基本信息', group: '控制器 / 辅助功能', label: `${b} ${c ?? ''}`.trim() };
  if (root === 'app' && a === 'assets' && b === 'manuals') return { tab: '基本信息', group: '手册', label: `手册 ${Number(c) + 1} · ${{ language: '语言', system: '系统', type: '类型' }[d] ?? d}` };
  if (root === 'app' && a === 'content' && b === 'reviews')
    return { tab: '描述', group: '奖项与评测', label: `评测 ${Number(c) + 1} 的${{ score: '分数', site: '来源', url: '链接' }[d] ?? d}` };
  if (root === 'app' && a === 'content' && b === 'sections')
    return { tab: '描述', group: `自定义区块 ${Number(c) + 1}`, label: { allowed_countries: '仅限这些国家显示', restricted_countries: '这些国家不显示' }[d] ?? d };
  if (root === 'app' && a === 'broadcast')
    return { tab: '特别设置', group: '直播', label: { chat_visibility: '聊天显示', title_choice: '直播标题选项', sidepanel_template: '侧边面板模板' }[b] ?? b };
  if (root === 'app' && a === 'related_items') return { tab: '特别设置', group: '相关项目', label: parts.slice(2).join(' · ') };
  return { tab: '其他', group: '其他字段', label: s || key };
}

export function describeField(key: string, scraped?: string): FieldInfo {
  const loc = splitLocalized(key);
  return loc ? localized(loc.path) : common(key, scraped);
}
