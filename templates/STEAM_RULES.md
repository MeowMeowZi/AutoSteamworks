# Steam 商店内容规则（给 AI 和人看）

这个项目用 AutoSteamworks 把本地文件同步到 Steamworks 后台。修改商店内容时按下面的规则来。

## AI 修改时必须遵守

1. **只改本地文件，不上传。** 上传由人在后台网页（`autosw ui`）里看完差异后点按钮完成。不要运行 `push`、`assets`、`build`。
2. 只改 `apps/<app>/store/` 和 `apps/<app>/assets/` 下的文件。不要改 `.autosw/`（快照和登录信息）。
3. 改完运行 `autosw check`（在 AutoSteamworks 仓库里是 `npm run autosw -- -c <配置路径> check`），把报出的错误修掉。
4. 不要新增 yaml 里没有的 key，也不要删 key：删掉 key 表示“不再同步这个字段”，不是“清空”。要清空就把值改成空字符串。
5. 只改用户要求的语言和字段。翻译时以 `english` 为准，除非用户另有说明。
6. 不确定的事实（价格、发售日期、奖项、评分、硬件需求）不要编，留给用户填。

## 文件布局

```
apps/<app>/store/
  _common.yaml              和语言无关的字段，key 是后台表单字段名
  <语言>/about.bbcode        关于此游戏（长文本，BBCode）
  <语言>/short_description.bbcode   简短描述
  <语言>/legal.bbcode、earlyaccess.*.bbcode …
  <语言>/_fields.yaml        该语言的其余字段，例如 sysreqs.windows.min.processor
apps/<app>/assets/          图片，说明见那里的 README.md
```

语言名用 Steam 的 API 名：`english`、`schinese`（简体）、`tchinese`（繁体）、`japanese`、`koreana` 等。

## Steam 的硬性规则

- **简短描述**：后台标注“长度 200-300 个字符”，超过 300 会标红（`autosw check` 会检查）。商店页顶部、搜索结果里显示的就是它。
- 文本用 **BBCode**，不支持 HTML 和 Markdown。常用标签：
  `[h1] [h2] [h3] [b] [i] [u] [strike] [url=https://…]文字[/url] [list][*]…[/list] [olist][*]…[/olist] [hr][/hr]`
  标签要成对闭合（`[*]` 和 `[hr]` 除外）。简短描述里不要用标签。
- “关于此游戏”里的图片要先在后台上传，再用后台生成的 `[img]{STEAM_APP_IMAGE}/extras/…[/img]` 引用；不能直接引用外部图片地址。
- 不能在商店页上放其他商店（Epic、itch.io 等）的链接或引导站外购买。
- 基础宣传图只能有游戏美术、游戏名称和官方副标题，不能有评测引语、奖项、“特价”之类的文字。
- 截图必须是游戏实际画面，不能是概念图或宣传图。

## 建议（不是硬性规则）

- 不要写无法证实的比较（“最好玩的”“第一款”），不要引用没有授权的评测或奖项。
- 简短描述开头就说清楚玩法，不要只写剧情。

## 本项目的风格（用户自己填写）

- 游戏一句话介绍：
- 目标玩家：
- 语气（例如：轻松幽默 / 严肃史诗）：
- 术语表（各语言统一译法）：
  - 示例：邪神 = Evil God
- 不要出现的词：
