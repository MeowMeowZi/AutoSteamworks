import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { Config } from './config.js';

export const PARTNER_HOME = 'https://partner.steamgames.com/';

/** 持久化的浏览器配置文件：登录一次，之后复用 Cookie */
export async function openBrowser(cfg: Pick<Config, 'profileDir' | 'browserChannel'>, headless: boolean) {
  const ctx: BrowserContext = await chromium.launchPersistentContext(cfg.profileDir, {
    channel: cfg.browserChannel === 'chromium' ? undefined : cfg.browserChannel,
    headless,
    viewport: { width: 1400, height: 900 },
  });
  const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
  return { ctx, page };
}

/** Steam 登录后会在 partner 域名下设置 steamLoginSecure Cookie */
export async function hasLoginCookie(ctx: BrowserContext) {
  return (await ctx.cookies(PARTNER_HOME)).some((c) => c.name === 'steamLoginSecure');
}

export function isLoginPage(url: string) {
  return /\/login/i.test(url);
}

/** 没登录（或没权限）时，Steamworks 会跳回首页并带上 ?goto=<原地址> */
export function isGotoRedirect(url: string) {
  try {
    return new URL(url).searchParams.has('goto');
  } catch {
    return false;
  }
}

/** Steamworks 的编辑页会保持长连接，networkidle 永远等不到；所以等 load 之后再尽量等网络空闲 */
export async function settle(page: Page) {
  await page.waitForLoadState('load');
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

/** 没登录（或登录过期）。runner 靠它判断要不要在网页上提示登录 */
export class NotLoggedInError extends Error {
  override name = 'NotLoggedInError';
}

export async function gotoPartner(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'load' });
  await settle(page);
  const now = page.url();
  if (isLoginPage(now) || isGotoRedirect(now)) {
    if (!(await hasLoginCookie(page.context()))) {
      throw new NotLoggedInError('Steamworks 还没登录或登录已过期：请在网页上点“登录”（命令行是 `autosw login`），登录后再试');
    }
    throw new Error(`已登录，但后台把请求跳回了首页（${now}）：当前账号可能没有这个 App 的权限，`
      + '或者 App 属于另一个机构——请在 Steamworks 里切换到对应的机构后再试');
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
