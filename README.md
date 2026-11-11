# AutoSteamworks

在本地编辑 Steam 商店页面内容和游戏构建，用一条命令同步到 Steamworks 后台。支持同时管理多个 App（游戏本体、Demo、DLC…）。

Steamworks **没有**修改商店页面的官方 API。这个工具通过浏览器自动化，用你自己登录的会话操作 partner.steamgames.com。构建上传走的是官方的 SteamPipe（steamcmd）。

## 快速开始

**安装（Windows）**：打开 PowerShell，运行这一行：

```powershell
irm https://raw.githubusercontent.com/MeowMeowZi/AutoSteamworks/main/install.ps1 | iex
```

它会检查 Node.js（没有就用 winget 装）、安装 AutoSteamworks，并在桌面和开始菜单创建“AutoSteamworks”快捷方式。以后再运行一次就是更新。

**使用**：双击桌面上的“AutoSteamworks”，浏览器里会打开后台网页，之后全部在网页上操作：

1. **添加游戏项目**：点“选择文件夹…”，选游戏工程的文件夹。第一次会让你填游戏名称、App ID 和要同步的语言。
2. **登录 Steam**：点右上角“登录 Steam”，在弹出的浏览器里登录 Steamworks（包括 Steam Guard）。所有项目共用这个登录，只需要一次。
3. **从后台拉取**：把商店页内容下载到本地。
4. 修改文本和图片（在网页上改，或者让 AI 按 STEAM_RULES.md 改），看完差异后勾选上传。

项目的配置（App、语言、截图年龄声明等）在网页的“设置”里改，给 AI 的规则在“AI 规则”里改。网页右上角的“退出”会停止后台；再双击快捷方式就会重新打开（已经在运行时直接打开现有的页面）。

### 命令行（可选）

所有操作也都能用命令行完成，适合自动化或者在游戏项目目录里直接用：

```powershell
autosw               # 等同于 autosw ui：打开后台网页；当前目录是游戏项目时自动打开它
autosw init          # 生成 steam.config.yaml、STEAM_RULES.md，并把 .autosw/ 加进 .gitignore
autosw login         # 登录 Steamworks
autosw pull          # 拉取商店内容
autosw status        # 离线查看改了什么
autosw check         # 离线按规则检查
autosw diff          # 和线上做三方对比（本地 / 线上 / 上次同步）
autosw push -n       # 先演练一遍
autosw push          # 保存到后台（不会自动发布）
autosw assets        # 上传新增或改过的图片
autosw build game    # 用 steamcmd 上传构建
autosw shortcut      # 重新创建桌面和开始菜单快捷方式
```

- 用 `-c path/to/steam.config.yaml` 指定别处的配置；内容和状态目录都相对于配置文件。
- 登录信息和项目列表存在 `~/.autosteamworks/`。项目里已经有旧的 `.autosw/profile` 时继续用它；也可以在配置里用 `browser.profileDir` 指定。
- 在这个仓库里开发时，用 `npm i --include=dev` 安装依赖（本机设置了 `NODE_ENV=production`），然后用 `npm run autosw -- <命令>`。

## 后台网页和 AI 修改

```powershell
npm run autosw -- ui         # 打开 http://127.0.0.1:5180/
```

- 左边是配置里的各个 App，右边分“商店文本”和“图片”两页。
- 文本按字段分卡片，各语言并排显示；本地改过的字段会标出来，并高亮删掉和新增的文字。可以打开 BBCode 预览，也可以直接在网页上编辑或还原。
- 顶部的“规则检查”会提示超长的简短描述、没闭合的 BBCode 标签、还没翻译的语言。
- “和线上对比”会读一次后台，标出线上被别人改过的字段和冲突。
- 勾选要上传的字段或图片，先点“演练”，再点“上传选中的”。上传前会再和线上对比一次，冲突字段默认不勾选。保存的都是草稿，不点发布不会上线。
- 本地文件一变（编辑器或 AI 改的）网页就自动刷新，不用手动重载。
- 只监听本机地址，其他网站的页面不能调用它的接口。

**让 AI 改内容：** `init` 会在项目里生成 `STEAM_RULES.md`，里面写了文件布局、Steam 的规则和 AI 必须遵守的约定（只改本地文件、不上传、改完运行 `check`）。末尾的“本项目的风格”由你自己填：语气、术语表、不要出现的词。然后对 AI（例如 Claude Code）说“按 STEAM_RULES.md 把简短描述翻译成英文”，它改完文件，你在网页上看差异，满意了就勾选上传。

```powershell
npm run autosw -- check      # 离线检查规则 + 列出未上传的改动，有错误时退出码为 1
```

## 同步怎么工作

- 商店编辑页（`admin/game/editbyappid/<appid>`）把所有数据放在一个 `#gameform` 表单里。每种语言的文本存在各自的隐藏字段中，例如 `app[content][about][schinese]`；页面上的编辑器只是界面。
- 工具只按字段的 `name` 属性读写这些隐藏字段，不依赖页面布局，所以 Valve 改样式不会影响。
- 保存时用浏览器自己的 `FormData` 提交整个表单，提交内容和点“保存”一样，但不经过编辑器界面，界面就没有机会覆盖写入的值。没配置的语言按原值一起提交，不会丢失。
- `pull` 会把线上的值同时存成本地文件和快照（`.autosw/snapshots`）。
- `push` 时做三方对比：
  - 只有本地改了 → 推送
  - 只有线上改了（比如别人直接在后台改了）→ 不覆盖，提示你先 pull
  - 两边都改了 → 视为冲突并跳过，加 `--force` 才以本地为准
- 保存后会重新加载页面，确认值真的写进去了，没写进去的会报错。
- 本地有未推送的改动时，`pull` 不会覆盖本地文件。

本地文件布局：

```
apps/<app>/store/
  _common.yaml                    ← 和语言无关的字段（名称、链接、平台、类型、分类…），key 是表单字段 name
  <语言>/                          ← 只包含配置里 languages 列出的语言
    about.bbcode                  ← 关于此游戏
    short_description.bbcode      ← 简短描述
    legal.bbcode、earlyaccess.*.bbcode …   ← store.files 匹配的长文本，一个字段一个文件
    _fields.yaml                  ← 该语言其余的字段，例如 sysreqs.windows.min.processor
```

本地化字段的路径规则：`app[content][X][Y][<语言>]` → `<语言>/X.Y`；不在 `content` 下的字段写成 `app.` 开头，例如 `app.broadcast.title_custom`。从 yaml 里删掉某个 key，就表示不同步这个字段。

出问题时，用 `inspect <app> --headed` 导出所有字段和整页截图到 `.autosw/inspect/`，方便排查。

## 各类内容的进度

| 内容 | 状态 |
|---|---|
| 商店文本（所有表单字段、多语言） | ✅ 已在真实后台上验证 pull / push / diff（602 个字段） |
| 构建上传（SteamPipe） | ✅ 已实现（生成 VDF + 调用 steamcmd），还没有真实上传过 |
| 宣传图、库资源、截图 | ✅ 已实现：`assets` 命令，按尺寸自动分类、只传改过的文件。已在真实后台上验证上传，并会从后台数据核对结果 |
| 预告片 | ⏳ 计划中 |
| 发布商店改动 | ⏳ 计划中：`push --publish`，要先在真实的发布页面上校准 |
| 成就（名称、描述、图标） | ⏳ 计划中 |
| 活动 / 公告 | ⏳ 计划中 |

## 安全

- `.autosw/profile` 里保存的是你的 Steam 登录 Cookie，已经写进 `.gitignore`，**不要提交，也不要分享**。
- 默认两次页面加载之间间隔 1.5 秒，所有操作按顺序执行，不并发。
- 构建上传建议用一个只有构建权限的专用 Steam 账号。

## 开发

```powershell
npm run typecheck
npm test          # 启动一个本地模拟后台，跑完整的 pull/push/冲突流程（使用系统的 Edge）
```
