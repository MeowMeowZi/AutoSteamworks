# Steam 商店内容规则（给 AI 和人看）

这个游戏项目用 AutoSteamworks 把本地文件同步到 Steamworks 后台。
**分工**：AI 负责配置和写本地文件；人在 AutoSteamworks 网页（桌面快捷方式，或运行 `autosw`）上查看改动，再勾选上传。

## AI 必须遵守

1. **只改本地文件，不碰后台。** 不要运行 `push`、`assets`、`build`、`pull`、`login`，也不要自己打开 Steamworks 网页。需要拉取或上传时，请用户在网页上点按钮。
2. 只改这些文件：`steam.config.yaml`、`STEAM_RULES.md` 末尾“本项目的风格”一节、`apps/<app>/store/`、`apps/<app>/assets/`。不要改 `.autosw/`（快照、上传记录、登录信息）。
3. **不要编造事实**：appid、depot id、价格、发售日期、奖项、评测和评分、硬件需求、构建账号都不能猜。在项目里找不到就问用户，或者先留空、在总结里列出来。
4. 不要在 yaml 里新增 key，也不要删 key（删掉 key 表示“不再同步这个字段”，不是“清空”）。要清空就把值改成空字符串 `""`。
5. 只改用户要求的语言和字段。翻译以 `english` 为准，用户另有说明时除外。各语言的译法按下面的术语表统一。
6. 改完运行检查，把报出的错误修掉：
   - 全局安装的：`autosw -c steam.config.yaml check`
   - 网页的“AI 规则”页复制出来的提示里有本机可用的完整命令，以那个为准。
7. 最后给用户一份总结：改了哪些文件；哪些内容需要用户确认或补充；接下来要在网页上做什么，例如“拉取”或“上传”。

## 工作流程

### 第 1 步：确认现状

- 读 `steam.config.yaml`，记下各 App 的 key、appid 和语言。
- 看 `apps/<app>/store/_common.yaml` 是否存在。**不存在说明还没从后台拉取过**：请用户在网页上点“从后台拉取”，拉取完再继续写商店文本。没拉取就不知道后台有哪些字段，不要自己创建 store 目录。
- `steam.config.yaml` 不存在时，请用户在网页的“项目”页添加这个文件夹并初始化。初始化需要 appid，appid 在 Steamworks 后台 App 名称旁边。

### 第 2 步：从项目里收集资料

在游戏项目里找这些信息，并记下来源：
- 游戏名、简介、玩法、卖点：README、策划或设计文档、宣传文案、旧的商店文本、itch.io 页面草稿等。
- 引擎设置里的产品名、公司名：Unity 在 `ProjectSettings/ProjectSettings.asset`（productName、companyName）；Godot 在 `project.godot`；Unreal 在 `Config/DefaultGame.ini`。
- 本地化表或翻译文件：用里面已有的术语译法。
- 游戏导出目录，例如 `Builds/`、`Export/`、`bin/`：配置构建时要用。
- 可以用作宣传图和截图的图片。

### 第 3 步：填写“本项目的风格”

根据第 2 步的资料，填好本文件末尾的一句话介绍、目标玩家、语气和术语表。拿不准的写上“（待确认）”，并在总结里请用户确认。以后写任何文本都按这一节来。

### 第 4 步：写商店文本

建议的顺序：简短描述 → 关于此游戏 → 抢先体验问答（如果是抢先体验）→ 版权声明 → 系统需求 → 其他语言的翻译。各字段对应的文件见下面的“商店文本文件”。

### 第 5 步：整理图片

AI 不画图，但可以把项目里已有的、**尺寸正好合适**的图片**复制**（不是移动）到 `apps/<app>/assets/` 里对应的目录。尺寸表见下面的“图片”一节。缺哪些槽位，就在总结里列出来。

### 第 6 步：检查和总结

运行第 6 条规则里的检查命令，修掉错误，然后按第 7 条写总结。

## 配置文件 steam.config.yaml

路径都相对于配置文件所在的目录。网页的“设置”页也能改其中一部分。

```yaml
browser:
  channel: msedge            # 不要改，除非用户要求（可选 msedge / chrome）
  # profileDir: ...          # 登录信息目录，不要改
partner:
  delayMs: 1500              # 后台请求间隔，不要改
store:
  ignoreFields: []           # 不想同步的字段 name，支持 * 通配，例如 "app[content][sysreqs][mac]*"
languages: [english, schinese]   # 所有 App 默认同步的语言（Steam 语言 API 名）
steamcmd:                    # 只有上传构建时才需要
  path: steamcmd             # 不在 PATH 里就写完整路径；问用户
  user: <构建账号>            # Steam 构建账号的用户名；必须问用户，不要猜
apps:
  game:                      # App 标识：小写字母、数字、- 和 _
    appid: 1234560           # 必须来自用户或后台，不要猜
    name: 游戏名
    # languages: [english]   # 这个 App 单独的语言，不写就用上面的 languages
    assets:
      screenshotsAllAges: true   # 截图是否适合所有年龄。必须由用户确认，不确认就不要写
    build:                   # 上传构建用，可选
      setLive: beta          # 构建完成后设为哪个分支，不能是 default
      depots:
        - id: 1234561        # depot id，在后台“SteamPipe → Depots”里，问用户
          contentRoot: builds/windows   # 游戏导出目录
          exclude: ["*.pdb"]
  demo:                      # 有 Demo、原声带 DLC 时照这个格式加，appid 问用户
    appid: 1234570
    name: 游戏名 Demo
```

改了 `languages`，或者新加了 App，都要请用户在网页上重新“从后台拉取”，新语言和新 App 的文件由拉取生成。

## 商店文本文件

```
apps/<app>/store/
  _common.yaml                     和语言无关的字段，key 是后台表单字段名
  <语言>/short_description.bbcode   简短描述（商店页顶部、搜索结果里显示的那段）
  <语言>/about.bbcode               关于此游戏（长文本）
  <语言>/sections.<n>.content.bbcode   自定义区块的内容（标题在 _fields.yaml 的 sections.<n>.label）
  <语言>/earlyaccess.*.bbcode       抢先体验问答：why 为何采用抢先体验、how_long 大约持续多久、
                                   full_version 完整版有何不同、current_state 现状、
                                   pricing 价格是否变化、community 社区如何参与
  <语言>/legal.bbcode               版权和商标声明
  <语言>/_fields.yaml               该语言的其余字段：sysreqs.<系统>.<min|rec>.<processor|graphics|osversion|soundcard|notes>（系统需求文字）、
                                   awards.short（奖项）、reviews.<n>.quote（评测引语）、app.broadcast.title_custom（直播标题）
```

`_common.yaml` 里常用的 key：
- `app[name]` 产品名称
- `app[content][links][website]`、`[discord_server]`、`[youtube]`、`[twitter]`、`[privacy_policy]` 等是各种链接；`app[content][support_info][email]` / `[url]` 是客服邮箱和网址
- `app[content][sysreqs][windows][min][memory][amount]`、`[units]`（MB / GB）是内存；`[diskspace]` 是存储空间
- 以 `[=值]` 结尾的 key 是复选框，值是 `true` / `false`
- 开发者、发行商（`app[game][developers]…`、`app[game][publishers]…`）在后台是用搜索框选的，**不要改**
- 类型（`rgGenres`、`primary_genre`）、功能（`category`）、支持语言（`supported_languages`）、平台（`platforms`）这类选项，**除非用户明确要求，否则不要改**，交给用户在网页上看着中文名称确认

语言名用 Steam 的 API 名：`english`、`schinese`（简体）、`tchinese`（繁体）、`japanese`、`koreana`、`german`、`french`、`russian`、`spanish`、`latam`、`brazilian` 等。

## 图片

```
apps/<app>/assets/
  store/<语言>/       商店宣传图（必填，至少要有一套 english）
    920 x 430           形象图片
    462 x 174           小宣传图
    1232 x 706          主宣传图
    748 x 896           竖向宣传图
    1438 x 810          页面背景（可选）
  library/<语言>/     Steam 库资源
    3840 x 1240         库主页图片
    600 x 900           库宣传图
    920 x 430           库形象图片
    1280 x 720          库徽标（宽或高等于这个值即可，背景要透明）
  screenshots/        截图，所有语言共用，至少 1920 x 1080
```

文件名随意，工具按尺寸识别类型，所以尺寸必须完全一致（截图和库徽标除外）。建议用 PNG。

## Steam 的硬性规则

- **简短描述**：后台标注长度为 200-300 个字符，超过 300 会标红（`check` 会检查）。开头就说清楚玩法，不要只写剧情。不要用 BBCode 标签。
- 文本用 **BBCode**，不支持 HTML 和 Markdown。常用标签：
  `[h1] [h2] [h3] [b] [i] [u] [strike] [url=https://…]文字[/url] [list][*]…[/list] [olist][*]…[/olist] [hr]`
  标签要成对闭合（`[*]`、`[hr]` 除外）。BBCode 没有注释语法，写进文件的内容都会显示在商店页上。
- “关于此游戏”里的图片要先在后台上传，再用后台生成的 `[img]{STEAM_APP_IMAGE}/extras/…[/img]` 引用，不能直接用外部图片地址。AI 不要自己写 `[img]`，哪里适合配图写在总结里告诉用户。
- 不能放其他商店（Epic、itch.io 等）的链接，也不能引导玩家到站外购买。
- 基础宣传图只能有游戏美术、游戏名称和官方副标题，不能有评测引语、奖项、“特价”之类的文字。
- 截图必须是游戏的实际画面，不能用概念图或宣传图。
- 不要写无法证实的比较，比如“最好玩的”“第一款”；没有授权的评测和奖项不要引用。

## 本项目的风格（AI 根据项目资料填写，用户确认）

- 游戏一句话介绍：
- 目标玩家：
- 语气（例如：轻松幽默 / 严肃史诗）：
- 术语表（各语言统一译法）：
  - 示例：邪神 = Evil God
- 不要出现的词：
