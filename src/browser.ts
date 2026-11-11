import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { Config } from './config.js';

export const PARTNER_HOME = 'https://partner.steamgames.com/';

/** 持久化的浏览器配置文件：登录一次，之后复用 Cookie */
export async function openBrowser(cfg: Config, headless: boolean) {
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

/** Steamworks 的编辑页会保持长连接，networkidle 永远等不到；所以等 load 之后再尽量等网络空闲 */
export async function settle(page: Page) {
  await page.waitForLoadState('load');
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

export async function gotoPartner(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'load' });
  await settle(page);
  if (isLoginPage(page.url())) {
    throw new Error('Steamworks 会话未登录或已过期，请先运行 `npm run autosw -- login`');
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
