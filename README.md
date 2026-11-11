# AutoSteamworks

在本地编辑 Steam 商店页面内容和游戏构建，用一条命令同步到 Steamworks 后台。支持同时管理多个 App（游戏本体、Demo、DLC…）。

Steamworks **没有**修改商店页面的官方 API。这个工具通过浏览器自动化，用你自己登录的会话操作 partner.steamgames.com。构建上传走的是官方的 SteamPipe（steamcmd）。

## 快速开始

```powershell
npm i --include=dev          # 本机设置了 NODE_ENV=production，需要显式安装开发依赖
npm run autosw -- init       # 生成 steam.config.yaml，填入 appid
npm run autosw -- login      # 弹出 Edge，手动登录一次（包括 Steam Guard）
npm run autosw -- inspect game -l english --headed   # 第一次使用前必须做，见下面的“校准”
npm run autosw -- pull       # 把所有 App、所有语言的商店内容拉到 apps/<key>/store/<lang>/
# …编辑本地文件…
npm run autosw -- status     # 离线查看改了什么
npm run autosw -- diff       # 和线上做三方对比（本地 / 线上 / 上次同步）
npm run autosw -- push -n    # 先演练一遍
npm run autosw -- push       # 保存到后台（不会自动发布）
npm run autosw -- assets -n  # 看看 apps/game/assets 里的图片会被识别成什么
npm run autosw -- assets     # 上传新增或改过的图片（说明见 apps/game/assets/README.md）
npm run autosw -- build game # 用 steamcmd 上传构建
```

用 `-c path/to/steam.config.yaml` 可以把配置和内容放在另一个 git 仓库里。

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
