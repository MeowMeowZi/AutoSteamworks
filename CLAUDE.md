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
| `delete-image` + 网页上“从后台删除”：删除宣传图 / 库资源 / 页面背景 | ⚠ 模拟后台测试通过；真实后台只跑过演练（找到了 schinese 形象图片的删除链接），还没真正删过。截图删除没做 |
| `ui`：本地后台网页（查看、编辑、规则检查、勾选上传）+ `check`（离线规则检查） | ✅ 模拟后台测试通过；在真实项目上打开过页面（只读），还没在网页上真实上传过 |
| 打包：`npm i -g github:MeowMeowZi/AutoSteamworks` 后在任何目录用 `autosw` | ✅ 用 npm pack + 全局安装到临时目录（omit=dev）验证过 init / help / ui |
| 启动项 + 网页里管理一切：`install.ps1` 一键安装并创建快捷方式；网页上添加项目、初始化、设置、AI 规则、登录、退出 | ✅ 模拟后台测试 + 沙盒里用 Edge 点过完整流程；快捷方式在临时目录验证过；install.ps1 只做了语法检查，还没在干净的机器上跑过 |
| 按 App ID 添加项目：网页“项目”页只填 App ID（名称可选），自动在 `~/AutoSteamworks/<appid> <名称>/` 建文件夹并初始化（语言默认 english + schinese）；同一个 appid 已有项目时直接打开。接口 `POST /api/projects/create`，位置可用 `AUTOSW_PROJECTS` 覆盖（测试时在 `AUTOSW_HOME/projects`） | ✅ 网页接口测试通过 |
| AI 规则：`templates/STEAM_RULES.md` 是给游戏项目里的 AI 用的完整手册（工作流程、配置说明、字段对照、Steam 规则）；网页“AI 规则”页的“复制给 AI”会生成“项目现状 + 规则全文”；规则文件是旧版时可以一键升级（保留“本项目的风格”一节）；初始化时在游戏项目的 CLAUDE.md（以及已有的 AGENTS.md）里加上指向规则文件的说明 | ✅ 模拟测试通过；还没在真实游戏项目里让 AI 照着跑过 |
| 图片收件箱：图片丢进 `assets/待分类/`，按尺寸判断位置、按文件名判断语言（没写算 english；920x430 文件名带 library/库 才算库形象图片），网页上点“整理”或 `sort-images [-n]`；同位置旧图挪到 `assets/已替换/`。网页上可以直接拖拽：拖到空白处 = 放进待分类并自动整理，拖到表格某一格 = 直接放到那个位置和语言（尺寸不符拒绝）；也有“选择图片…”按钮。接口 `POST /api/images/drop`，请求体就是文件 | ✅ 离线测试 + 网页接口测试通过；拖拽事件在无头 Edge 里实测过 |
| 拉取时跟随后台语言：后台“支持的语言”里勾了“界面”、且有商店文本的语言（STEAM_LANGS），拉取时自动加进 steam.config.yaml 并一起拉下来（App 有自己的 languages 就加到那里；项目只有一个 App 时加到顶层；否则给这个 App 单独写一份）。只加不删 | ✅ 模拟后台测试通过；真实后台还没跑过 |
| 未登录检测：后台把请求跳回首页（`/?goto=...`）时，没有 `steamLoginSecure` 就提示登录，有就提示可能没权限 / 机构不对 | ✅ 真实后台遇到过（新项目用的共享登录还没登录） |
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
- **删除图片**（2026-11-11 探查，scripts/probe-delete*.ts）：每张已上传的图旁有“删除”链接，onclick 是 `SubmitQuickMessageUpdate({"app[assets][header_image][image][schinese]":"", ...image2x..., ...image2x_raw...})`，它把字段加进 `#quick_message_update` 表单（sessionid、save_redirect=edit）再加 activetab，普通表单 POST 到 `save/<itemid>`。我们从页面上读这个链接的参数，不自己拼字段名。截图的删除是另一套：`DeleteScreenshot` → `quickupdateajax/<itemid>`，参数 `app[assets][screenshots][<序号>] = ''`，还没做。
- **会话**：页面有长连接，`networkidle` 永远等不到。统一用 `src/browser.ts` 里的 `settle()`：等 load，再最多等 5 秒网络空闲。
- **图片槽位**（2026-11-11 读 g_ImageTypes 和 IsImageTypeValid）：一般要求尺寸完全一致；库徽标宽或高一致即可；截图只要求不小于 1920x1080。没有类型开启 supports2x。商店的 4 张宣传图是必填（后台标 *），后台顶部“商店资产 0/4 已添加”只按英文版计数。
- **后台显示已上传图片的方式**：后台把文件改名为 `header_schinese.jpg` 之类，列表里只有“简体中文 920 x 430 新”这样一行，点语言名才显示图片。图片 CDN 是 `https://shared.cdn.queniuqe.com/store_item_assets/steam/apps/<appid>/<hash>/<文件名>`（从页面链接里读到）。用户曾因此以为上传失败，网页上要写清楚后台位置。
- **抢先体验问题的中文原文**、复选框文字等见 src/fieldInfo.ts 和 .autosw/inspect/field-labels.json。
- **App 管理首页**：`/apps/landing/<appid>`，上面有各后台页面的链接，探查新功能时可以从这里开始。

## 代码结构

```
bin/autosw.js              命令入口：用 tsx 的 register() 直接加载 src/cli.ts，没有构建步骤（tsx 因此是运行时依赖）
start.bat                  开发用启动脚本（双击 = node bin/autosw.js ui），CRLF 换行，见 .gitattributes
src/cli.ts                 所有命令；不带命令时默认运行 ui，端口已被占用时直接打开已有的网页
src/projects.ts            项目列表（~/.autosteamworks/projects.json）、网页上的初始化、设置读写（YAML Document，保留注释）、STEAM_RULES.md 读写
src/desktop.ts             Windows：创建快捷方式（WScript.Shell）、选择文件夹对话框（FolderBrowserDialog）、打开网址
install.ps1                一键安装脚本，必须保持 UTF-8 无 BOM（BOM 会让 irm | iex 报错）
src/config.ts              steam.config.yaml 解析（多 App、各 App 可覆盖 store/assets/build 配置）
src/browser.ts             持久化浏览器、登录检测、settle()
src/partner/form.ts        通用表单读写（按 name 定位；hidden/radio/checkbox）+ FormData 提交
src/partner/store.ts       商店页拉取/推送；BUILTIN_IGNORE 里是内部字段
src/partner/assets.ts      图片上传 + 上传后核对
src/local/storeFiles.ts    本地布局：_common.yaml + <语言>/*.bbcode + <语言>/_fields.yaml；快照
src/local/inbox.ts         “待分类”收件箱：计划（planInbox）和整理（sortInbox），语言线索（langHints）
src/local/assetFiles.ts    扫描 assets/{store,library}/<语言>/、assets/screenshots/；上传记录（sha256）
src/ops.ts                 pull / diff / push / assets 的核心流程，命令行和网页共用（输出走 log 回调）
src/lint.ts                规则检查（简短描述长度、BBCode 闭合、未翻译）
src/ui/server.ts           `ui` 命令的 HTTP 服务：/api/state、/api/run（同一时间只跑一个任务）、/api/field、SSE /api/events（轮询文件 mtime）
src/ui/page.html           网页，原生 JS，不需要构建。概览（本地 → 草稿 → 发布）、结果框、文本按后台页签分组、图片按槽位 × 语言排成表
src/ui/images.ts           图片表的数据：每格的本地文件、后台路径、状态（待上传 / 已在后台 / 缺少必填…）
src/slots.ts               后台图片槽位表（照抄 g_ImageTypes）和按尺寸识别（照抄 IsImageTypeValid）
src/fieldInfo.ts           字段名 → 后台页签 / 分组 / 中文名
src/partner/meta.ts        后台状态快照（serialized_app_data.assets、CDN 前缀、复选框文字），pull/diff/push/assets 时保存到 .autosw/remote/
src/local/imageSize.ts     离线读 PNG/JPEG/GIF/WebP 尺寸
templates/STEAM_RULES.md   `init` 复制到游戏项目里，给 AI 看的规则。“## 本项目的风格”这个标题是升级时的分界线，不要改名
src/sync.ts                三方对比（本地 / 线上 / 快照）：local / remote / conflict / gone
src/build/steampipe.ts     生成 VDF + 调用 steamcmd
test/mock-partner.ts       模拟后台，按真实页面结构还原
test/e2e.ts                商店文本端到端测试
test/assets-e2e.ts         图片端到端测试
test/ui-e2e.ts             网页接口端到端测试（在进程内启动 startUi）
test/inbox-test.ts         收件箱整理测试（离线）
test/png.ts                测试用的 PNG 生成
scripts/*.ts               只读的探查脚本（explore、probe-desc、probe-assets、probe-assets2、probe-uploaded、probe-delete、probe-delete2）
```

状态文件都在 `.autosw/`（已加进 gitignore）：
- `profile/`：本项目旧的浏览器配置文件，**里面有登录 Cookie，绝对不要提交**。存在时继续用它；新项目默认用 `~/.autosteamworks/profile`（所有项目共用一个登录），配置项 `browser.profileDir` 可覆盖
- `snapshots/`：商店文本的快照
- `assets/`：图片上传记录
- `inspect/`：inspect 和探查脚本的输出

## 工作方式（这几轮下来的约定）

- **先只读探查，再写代码**：遇到新的后台页面，先写 `scripts/` 下的只读脚本，看 DOM、全局变量、后台的 JS，必要时用 curl 下载 `public/javascript/*.js` 到临时目录用 grep 读。不要靠猜。
- **第一次真实写入前要征得用户同意**：先 `--dry-run`，再真正执行，写完后要从后台核对结果。保存的都是草稿，不点发布就不会上线。
- **每个功能都要有模拟后台的端到端测试**：`npm test` 跑四套测试。注意测试必须异步调用 CLI，因为模拟服务器在同一个进程里，同步调用会把它卡死。
- **测试配置必须写 `browser.profileDir`**（指向临时目录），否则会用到真实的共享登录；网页测试还要设 `AUTOSW_HOME` 到临时目录，否则会改到真实的项目列表。
- **网页接口都带 project 参数**（配置文件路径），服务器只接受项目列表里的路径。同一时间只跑一个任务（共用一个浏览器配置文件）。
- **在 Bash 里用 heredoc / sed 写含反斜杠的代码很容易被吃掉**：这类修改用 Write 写 .autosw/ 下的临时 python 脚本再运行，或者直接用 Edit。
- **用户希望别人装好后双击快捷方式就能用，所有配置都在网页上完成**，新功能要优先在网页上提供入口。
- **规则检查只写确认过的规则**：简短描述的 200-300 是 2026-11-11 从真实编辑页的脚本里读到的（按 JS `.length` 计数，超过 300 只是标红，不阻止保存）。新增规则前先探查。
- **用户的使用方式**：这个工具以后会放进其他准备上架的游戏项目里用。网页负责查看和上传；AI（Claude Code）按游戏项目里的 `STEAM_RULES.md` 改本地文件，不直接上传。
- **用户的环境**：`NODE_ENV=production` 且 npm `omit=dev`，安装依赖要用 `npm i --include=dev`。TypeScript 7 需要在 tsconfig 里显式写 `"types": ["node"]`。
- **网页上和语言无关的字段**（page.html 的 renderCommon）：支持语言画成“语言 × 界面/完全音频/字幕”表；功能、类型、平台、向导类复选框画成标签；其余一行一个，字段名放在鼠标悬停提示里；存储空间/内存的数值和单位合成一行。改网页后用无头 Edge 截图检查（脚本放 `.autosw/` 下，在进程内 `startUi`，只做 GET）。
- **在浏览器里执行的代码写成字符串**传给 `page.evaluate`，避免 tsx 往函数里注入 `__name`。
- **和用户用中文交流**，代码注释和 CLI 输出也用中文。

## 常用命令

```powershell
npm run autosw -- login | pull | status | check | diff | push [-n] [-f] | assets [-n] [-f] | delete-image game "header|schinese" [-n] | ui | inspect game | build game [-n]
npm run typecheck
npm test
```

## 下一步候选（用户还没选）

1. 在网页上第一次对真实后台上传（先演练，再上传，再核对）。
2. `push --publish`：先只读探查发布页面（App 管理首页上应该有入口），弄清发布流程和需要确认的地方。
3. 构建上传：需要用户提供构建账号（`steamcmd.user`）和游戏导出目录（`contentRoot`），还要确认本机有没有装 steamcmd。
4. 成就：探查 `apps/achievements/5596340`。
5. 活动 / 公告，预告片。
