# AutoSteamworks

这是一个 CLI 工具，把本地文件一键同步到 Steamworks 后台（partner.steamgames.com），支持多个 App。
目标是覆盖所有内容：商店文本、图片、构建、发布、成就、活动。

技术栈：TypeScript + playwright-core。直接驱动系统自带的 Edge（`channel: msedge`），用持久化的浏览器会话保持登录。
Steamworks **没有**修改商店页面的官方 API，所以一切都靠操作后台网页完成；只有构建上传走官方的 SteamPipe（steamcmd）。

## 当前进度（截至 2026-11-11）

| 功能 | 状态 |
|---|---|
| `login`：弹出 Edge 手动登录，自动检测 `steamLoginSecure` Cookie | ✅ 真实后台验证 |
| `pull` / `status` / `diff` / `push`：商店文本 | ✅ 真实后台验证（602 个字段，写入 schinese 简短描述并核对） |
| `assets`：宣传图、库资源、截图 | ✅ 真实后台验证（上传了 schinese 形象图片，并从后台数据核对） |
| `ui`：本地后台网页（查看、编辑、规则检查、勾选上传）+ `check`（离线规则检查） | ✅ 模拟后台测试通过；在真实项目上打开过页面（只读），还没在网页上真实上传过 |
| 打包：`npm i -g github:MeowMeowZi/AutoSteamworks` 后在任何目录用 `autosw` | ✅ 用 npm pack + 全局安装到临时目录（omit=dev）验证过 init / help / ui |
| `build`：生成 VDF + 调用 steamcmd | ⚠ 已实现但从未真实运行；配置里 `steamcmd.user` 还是占位值，`builds/windows` 目录也不存在 |
| `push --publish`：发布 | ⏳ 未做，发布页面还没探查过 |
| 成就 | ⏳ 未做（后台地址 `https://partner.steamgames.com/apps/achievements/5596340`） |
| 活动 / 公告、预告片 | ⏳ 未做 |
| 商店页上的“下载本地化 / 上传本地化”（官方的 JSON/CSV 批量导入导出） | ⏳ 没研究，可以作为多语言文本的另一种同步方式 |

**后台里现在有两项测试数据**，正式发布前要替换掉：schinese 简短描述是“测试测试”，schinese 形象图片是 `测试.png`。
代码已推送到公开仓库 https://github.com/MeowMeowZi/AutoSteamworks（main 分支）。`apps/` 和 `steam.config.yaml` 是这款游戏自己的内容，已加进 gitignore，不进工具仓库。

## 用户的项目

- 游戏《邪神今天也在挂机》：appid `5596340`，depot `5596341`，商店 itemid `1436230`。
- 账号属于两个机构，当前选中的是 222306（Shanghai XinMeng）。
- 同步语言：english、schinese。用户已确认截图适合所有年龄（`screenshotsAllAges: true`），宣传图内容也符合 Steam 规定。

## 真实后台的结构（用 inspect 和探查脚本确认过）

- **商店编辑页**：`/admin/game/editbyappid/<appid>` 会重定向到 `/admin/game/edit/<itemid>`。所有语言都在同一个页面上。
- **数据在一个表单里**：`#gameform`，POST 到 `/admin/game/save/<itemid>`，大约 2400 个控件。
  - 本地化文本存在隐藏字段 `app[content][...][<lang>]` 里。页面上的 textarea 和 ProseMirror 编辑器没有 `name`，只是界面。
  - 我们用 `fetch(form.action, {body: new FormData(form)})` 提交整个表单，绕过界面的 submit 处理函数。
- **页面状态**：隐藏字段 `serialized_app_data`（JSON）里有已保存的 content 和 `assets`，例如 `assets.header_image.image.schinese = "<hash>/header_schinese.jpg"`。上传图片后靠它核对结果。
- **图片上传**：逻辑照搬 `game_admin.js` 里的 `UploadImages`。
  - 用页面自带的 `g_ImageTypes` 和 `IsImageTypeValid` 按尺寸判断类型。
  - 请求 key = 类型路径 [+ `|<lang>`]；截图的 key 是 `screenshot|assets|screenshots|0|english[]`，另外带 `params[<文件名>][all_ages]`，文件名里插入 `.AA1`。
  - POST 到 `save/<itemid>?activetab=tab_graphicalassets&json=1`。成功时返回 `{"redirect":"...SuccessMsg[0]=Changes+saved..."}`，失败时 redirect 地址里带 `ErrorMsg`。
- **会话**：页面有长连接，`networkidle` 永远等不到。统一用 `src/browser.ts` 里的 `settle()`：等 load，再最多等 5 秒网络空闲。
- **App 管理首页**：`/apps/landing/<appid>`，上面有各后台页面的链接，探查新功能时可以从这里开始。

## 代码结构

```
bin/autosw.js              命令入口：用 tsx 的 register() 直接加载 src/cli.ts，没有构建步骤（tsx 因此是运行时依赖）
src/cli.ts                 所有命令
src/config.ts              steam.config.yaml 解析（多 App、各 App 可覆盖 store/assets/build 配置）
src/browser.ts             持久化浏览器、登录检测、settle()
src/partner/form.ts        通用表单读写（按 name 定位；hidden/radio/checkbox）+ FormData 提交
src/partner/store.ts       商店页拉取/推送；BUILTIN_IGNORE 里是内部字段
src/partner/assets.ts      图片上传 + 上传后核对
src/local/storeFiles.ts    本地布局：_common.yaml + <语言>/*.bbcode + <语言>/_fields.yaml；快照
src/local/assetFiles.ts    扫描 assets/{store,library}/<语言>/、assets/screenshots/；上传记录（sha256）
src/ops.ts                 pull / diff / push / assets 的核心流程，命令行和网页共用（输出走 log 回调）
src/lint.ts                规则检查（简短描述长度、BBCode 闭合、未翻译）
src/ui/server.ts           `ui` 命令的 HTTP 服务：/api/state、/api/run（同一时间只跑一个任务）、/api/field、SSE /api/events（轮询文件 mtime）
src/ui/page.html           网页，原生 JS，不需要构建
templates/STEAM_RULES.md   `init` 复制到游戏项目里，给 AI 看的规则
src/sync.ts                三方对比（本地 / 线上 / 快照）：local / remote / conflict / gone
src/build/steampipe.ts     生成 VDF + 调用 steamcmd
test/mock-partner.ts       模拟后台，按真实页面结构还原
test/e2e.ts                商店文本端到端测试
test/assets-e2e.ts         图片端到端测试
test/ui-e2e.ts             网页接口端到端测试（在进程内启动 startUi）
test/png.ts                测试用的 PNG 生成
scripts/*.ts               只读的探查脚本（explore、probe-desc、probe-assets、probe-assets2、probe-uploaded）
```

状态文件都在 `.autosw/`（已加进 gitignore）：
- `profile/`：本项目旧的浏览器配置文件，**里面有登录 Cookie，绝对不要提交**。存在时继续用它；新项目默认用 `~/.autosteamworks/profile`（所有项目共用一个登录），配置项 `browser.profileDir` 可覆盖
- `snapshots/`：商店文本的快照
- `assets/`：图片上传记录
- `inspect/`：inspect 和探查脚本的输出

## 工作方式（这几轮下来的约定）

- **先只读探查，再写代码**：遇到新的后台页面，先写 `scripts/` 下的只读脚本，看 DOM、全局变量、后台的 JS，必要时用 curl 下载 `public/javascript/*.js` 到临时目录用 grep 读。不要靠猜。
- **第一次真实写入前要征得用户同意**：先 `--dry-run`，再真正执行，写完后要从后台核对结果。保存的都是草稿，不点发布就不会上线。
- **每个功能都要有模拟后台的端到端测试**：`npm test` 跑三套测试。注意测试必须异步调用 CLI，因为模拟服务器在同一个进程里，同步调用会把它卡死。
- **测试配置必须写 `browser.profileDir`**（指向临时目录），否则会用到真实的共享登录。
- **规则检查只写确认过的规则**：简短描述的 200-300 是 2026-11-11 从真实编辑页的脚本里读到的（按 JS `.length` 计数，超过 300 只是标红，不阻止保存）。新增规则前先探查。
- **用户的使用方式**：这个工具以后会放进其他准备上架的游戏项目里用。网页负责查看和上传；AI（Claude Code）按游戏项目里的 `STEAM_RULES.md` 改本地文件，不直接上传。
- **用户的环境**：`NODE_ENV=production` 且 npm `omit=dev`，安装依赖要用 `npm i --include=dev`。TypeScript 7 需要在 tsconfig 里显式写 `"types": ["node"]`。
- **在浏览器里执行的代码写成字符串**传给 `page.evaluate`，避免 tsx 往函数里注入 `__name`。
- **和用户用中文交流**，代码注释和 CLI 输出也用中文。

## 常用命令

```powershell
npm run autosw -- login | pull | status | check | diff | push [-n] [-f] | assets [-n] [-f] | ui | inspect game | build game [-n]
npm run typecheck
npm test
```

## 下一步候选（用户还没选）

1. 在网页上第一次对真实后台上传（先演练，再上传，再核对）。
2. `push --publish`：先只读探查发布页面（App 管理首页上应该有入口），弄清发布流程和需要确认的地方。
3. 构建上传：需要用户提供构建账号（`steamcmd.user`）和游戏导出目录（`contentRoot`），还要确认本机有没有装 steamcmd。
4. 成就：探查 `apps/achievements/5596340`。
5. 活动 / 公告，预告片。
