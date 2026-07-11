# assets/CREDITS.md — 素材授權登記表

依規格書第 9 章規則：任何新素材加入 repo 前，先在此登記名稱／作者／連結／
授權／義務。

| 名稱 | 作者 | 連結 | 授權 | 義務（署名/相同方式分享等） | 加入日期 | 用途 |
|---|---|---|---|---|---|---|
| office_shell_placeholder.png（4 格極簡 tileset：地板/牆/窗/門） | self-generated placeholder（本專案 `scripts/gen_office_shell.mjs` 程式生成） | （repo 內生成，無外部來源） | CC0（自製，放棄著作權） | 無 | 2026-07-07 | `office_shell.tmj` 底圖 tileset；待日後換 LimeZu Modern Office 時整組替換 |
| agent_*.png ×9（像素小人 4 向×3 幀 spritesheet，9 種衣色） | self-generated placeholder（本專案 `scripts/gen_agent_sprites.mjs` 程式生成） | （repo 內生成，無外部來源） | CC0（自製，放棄著作權） | 無 | 2026-07-07 | Phase 1 T1.4 的 9 名 agent 行走動畫；待日後換 LPC 產生器素材時整組替換並補署名 |
| office_shell_theme_warm.png / _cool.png / _dark.png（3 個背景主題 tileset，同 4 格語意：地板/牆/窗/門，配色不同） | self-generated placeholder（本專案 `scripts/gen_theme_tilesets.mjs` 程式生成） | （repo 內生成，無外部來源） | CC0（自製，放棄著作權） | 無 | 2026-07-11 | ADR-002 D4「世界設定」背景主題選擇器；與 office_shell_placeholder.png（default 主題）並列，供編輯器套用不同房間配色；待日後換 LimeZu 正式素材時視覺升級 |
| apple-touch-icon.png / apple-touch-icon-precomposed.png（180×180 像素風迷你辦公室圖示） | self-generated（本專案 `scripts/gen_touch_icon.mjs` 程式生成） | （repo 內生成，無外部來源） | CC0（自製，放棄著作權） | 無 | 2026-07-12 | 消除瀏覽器自動探測 touch icon 的 404；iOS 加入主畫面時的書籤圖示 |
| LimeZu「Modern Office Revamped v1.2」＋「Modern Interiors」真實素材（辦公室 339 件單品 ＋ 26 主題資料夾中實際存在的 24 個、共 5470 件單品；32×32 標準陰影，排除 16/48 尺寸與 Black_Shadow/Shadowless 重複變體） | LimeZu（itch.io） | https://limezu.itch.io/ | 付費授權，**素材原檔不得再散布** | 使用者本機自有授權；素材原檔（`assets/tilesets/limezu-modern-office/`）與 `scripts/sync_limezu_assets.mjs` 複製到 `web/public/tilesets/limezu-modern-office/` 的複本皆 gitignored，兩者都不進版控 | 2026-07-12 | ADR-003 D1：家具庫真實素材（分類編目 `manifest.json`：`catalog`/`sprites`/`categories`），取代原色塊 placeholder |
