# 术语表

**槽位（Slot）**：后台的一个图片位置，例如形象图片、小宣传图、页面背景、截图。数据照抄后台的 `g_ImageTypes`，见 `src/slots.ts`。按尺寸判断图片属于哪个槽位（`classify`）。

**格子（Cell）**：一个槽位 × 一种语言，是本地图片和后台图片一一对应的单位。key 写成 `<槽位 id>|<语言>`，例如 `header|schinese`；不分语言的槽位（页面背景、截图）只有一格，语言写 `*`，例如 `page_background|*`。普通格子一格只放一张图，新图替换旧图；截图格可以有很多张。key、本地目录、`*` 的语言回退、本地文件属于哪一格，都只在 `src/local/imageCells.ts` 里算。
_不要说_：位置 + 语言、slot key。

**待分类（收件箱）**：`assets/待分类/`，随便丢图片进去，按尺寸和文件名整理到对应的格子目录。被替换的旧图挪到 `assets/已替换/`。

**App 文本状态**：一个 App 的本地商店文本、上次同步的快照、本地改动和规则检查，见 `src/textState.ts`。**拉取过** = 本地文件和快照都有；只有本地文件时能做规则检查，但算不出改动。

**项目配置**：游戏项目里的 `steam.config.yaml`。没写的项按“App 自己的 →（Demo）正式版的 → 顶层 → 默认值”继承，规则和默认值只在 `src/config.ts` 里。设置页显示的是实际生效的值。

**Demo / 正式版**：Demo 是项目里的另一个 App，配置里写 `inherits: <正式版的 key>`（只能一层）。正式版商店页上的“关联的 Demo”（`app[related_items][demos][0][itemid]`）填的是 Demo 的 **itemid**，不是 appid。

**继承 / 覆盖**：Demo 没单独设置的内容用正式版的。
- 文本：Demo 实际生效的本地值 = 正式版的本地值（只取 Demo 后台表单里有的字段）+ Demo 自己文件里的**覆盖**。拉取 Demo 时只有和正式版不同、又不是空字符串的值才写成覆盖。规则只在 `src/local/storeFiles.ts`（readLocalLayers / writeLocal）。
- 图片：Demo 的格子没有图就用正式版同一格的图（**继承来的图**，rel 是 `../../<正式版>/assets/...`）；Demo 有英文版时其他语言不继承。规则只在 `src/local/imageCells.ts` 的 scanCells。
- “单独设置” = 给 Demo 加覆盖；“恢复继承” = 删掉覆盖（图片是把 Demo 自己的图挪到 `已替换/`）。
_不要说_：子 App、父 App、复制。
