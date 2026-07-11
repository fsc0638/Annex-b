# assets/ — 素材資產說明

本目錄不含任何付費素材原檔。依規格書第 9 章授權規則，本 repo 只放
CC0／CC-BY-SA 等可再散布授權的素材；付費素材（LimeZu）由使用者另行購買
後放到本機對應路徑，`.gitignore` 已排除其原檔不進版控。

## 目錄結構（Phase 0 建立，內容留待後續 Phase 填入）

```
assets/
├── maps/office_shell.tmj      # 只有牆/地板/門的殼（Tiled 製作，Phase 1 T1.1）
├── tilesets/                  # LimeZu Modern Office 等（見下方購買說明）
└── sprites/agents/            # 9 個角色 spritesheet（Phase 1）
```

## 素材來源與授權（規格書第 9 章）

| 資產 | 來源 | 授權 | 用途 | 注意 |
|---|---|---|---|---|
| **Modern Office**（首選）/ Modern Interiors | LimeZu（itch.io） | 免費層可測試；完整版付費，**素材原檔不得再散布** | 辦公桌椅、隔屏、影印機、會議桌、茶水間 tileset | repo 不含付費原檔 |
| Ninja Adventure Asset Pack | Pixel-Boy & AAA（itch.io） | CC0 | 備用角色/物件 | 可直接入 repo |
| Kenney 各系列 | kenney.nl | CC0 | UI icon、補充家具 | 可直接入 repo |
| Universal LPC Spritesheet Generator | GitHub 開源工具 | 產出多為 CC-BY-SA 3.0 / GPL 3.0 | 產 9 個角色 4 向行走圖（含西裝/制服風格） | 署名+相同方式分享義務：登記於 `CREDITS.md` |
| Tiled Map Editor | mapeditor.org | GPL（工具） | office_shell 底圖 | 不影響輸出檔 |

`[DEFAULT]` v2 用 CC0 + LimeZu 免費層。

## LimeZu 購買與放置說明

1. 前往 itch.io 搜尋 LimeZu「Modern Office」（或「Modern Interiors」）資產包。
2. 免費層即可先行測試；若需要更多辦公家具變化，購買完整版。
3. 下載後，將整包內容放到本機：
   ```
   assets/tilesets/limezu-modern-office/
   ```
   此路徑內容已被 `.gitignore` 排除（見下方規則）——**只有**
   `manifest.example.json`（schema 範本，見下一步）例外會進版控，不會被誤
   commit 真正的圖檔。
4. 複製 schema 範本並依你實際下載的檔名編輯：
   ```
   cp assets/tilesets/limezu-modern-office/manifest.example.json \
      assets/tilesets/limezu-modern-office/manifest.json
   ```
   （`manifest.example.json` 內的 `_comment`/`_schema_comment` 欄位說明每個
   欄位的意義；`sprites` 的 key 必須是編輯器認得的 10 種家具種類之一。）
5. 執行 `node scripts/sync_limezu_assets.mjs` 把 manifest.json 引用的檔案
   複製到 `web/public/tilesets/limezu-modern-office/`（同樣被 `.gitignore`
   整個排除）並產生前端可讀的 manifest.json；缺 `manifest.json` 或整個
   來源目錄時，此腳本會印出明確的下一步指引（不報錯）。地圖底圖本身不再
   靠 Tiled GUI 手動製作——由 `scripts/gen_office_shell.mjs` 產生（見
   `docs/CLAUDE.md` Phase 1 決策段）。
6. 若團隊多人開發，每個人各自依本說明在本機放置一份 LimeZu 素材與自己的
   `manifest.json`，不透過 git 同步。

## .gitignore 規則（防止誤 commit 付費素材）

除自產（`scripts/gen_*.mjs` 產生、已登記 `CREDITS.md`）之白名單檔案外，
第三方素材圖檔不會加入版控（白名單見 `.gitignore` 的 `!` 例外規則，如
`office_shell_placeholder.png` 與 `agent_*.png`）——請勿手動
`git add -f` 繞過這個防呆。

## 新增素材前的義務

任何新素材加入前，先登記 `assets/CREDITS.md`（名稱/作者/連結/授權/義務），
特別是 CC-BY-SA / GPL 類授權有「署名＋相同方式分享」義務，務必如實登記。
