"use client";

// Phase 3 wave 2 main shell: three tabs — 監控 (existing time controls +
// office canvas), 佈局編輯器 (LayoutEditorPanel, now compiling/mounted —
// deep completion is wave 3), 角色設定 (read-only AgentPanel, editing
// arrives wave 3). All three stay mounted simultaneously (hidden via CSS,
// not unmounted) so switching tabs doesn't drop the editor's in-progress
// local draft or tear down OfficeCanvas's WebGL/ws state.
//
// Normal mode connects to the engine's /ws; every (re)connect receives a
// world_snapshot that fully restores the client state (furniture layer
// included). NEXT_PUBLIC_MOCK_SNAPSHOT=1 skips the WebSocket entirely and
// renders the static fixture snapshot from /mock/world_snapshot.json —
// useful for UI work on machines without a running engine. In mock mode
// `send` stays null, which already puts LayoutEditorPanel into its
// local-only preview mode (no real PUT), so the editor/agent tabs are
// naturally read-only without extra plumbing.

import { useEffect, useRef, useState } from "react";
import OfficeCanvas from "@/game/OfficeCanvas";
import TimeControls from "@/panels/TimeControls";
import LayoutEditorPanel from "@/panels/LayoutEditorPanel";
import AgentPanel from "@/panels/AgentPanel";
import { useGameStore } from "@/game/store";
import type { WorldSnapshotMsg } from "@/game/types";
import { connectWs, wsUrl, type WsClient } from "@/ws/client";

const MOCK_MODE = process.env.NEXT_PUBLIC_MOCK_SNAPSHOT === "1";

type Tab = "monitor" | "editor" | "agents";

const TABS: { id: Tab; label: string }[] = [
  { id: "monitor", label: "監控" },
  { id: "editor", label: "佈局編輯器" },
  { id: "agents", label: "角色設定" },
];

export default function Home() {
  const clientRef = useRef<WsClient | null>(null);
  const [send, setSend] = useState<((payload: unknown) => void) | null>(null);
  const [tab, setTab] = useState<Tab>("monitor");

  useEffect(() => {
    const store = useGameStore.getState();
    if (MOCK_MODE) {
      store.setConn("mock");
      fetch("/mock/world_snapshot.json")
        .then((r) => r.json())
        .then((snap: WorldSnapshotMsg) => {
          useGameStore.getState().applyServerMsg(snap);
          // Static render: the mock world stays paused.
          useGameStore.setState({ running: false });
        })
        .catch(() => {
          useGameStore.setState({
            lastError: "無法載入 mock 快照（/mock/world_snapshot.json）",
          });
        });
      return;
    }

    const client = connectWs(wsUrl(), {
      onMessage: (msg) => useGameStore.getState().applyServerMsg(msg),
      onStatus: (status) => useGameStore.getState().setConn(status),
    });
    clientRef.current = client;
    setSend(() => (payload: unknown) => client.send(payload));
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-4 bg-slate-950 p-4 text-slate-100">
      <header className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Annex B — 晨翔航勤 合約與招商部</h1>
        <p className="text-sm text-slate-500">
          Phase 1：辦公室世界與通勤（07:00 開局，08:20 起陸續進場）
        </p>
      </header>

      <nav
        role="tablist"
        aria-label="主要分頁"
        className="flex w-fit gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1 text-sm"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
              tab === t.id
                ? "bg-cyan-800 text-cyan-50"
                : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div
        role="tabpanel"
        className={tab === "monitor" ? "flex flex-col gap-4" : "hidden"}
      >
        <TimeControls send={send} />
        <OfficeCanvas />
      </div>

      <div
        role="tabpanel"
        className={tab === "editor" ? "flex flex-col gap-2" : "hidden"}
      >
        {MOCK_MODE && (
          <p className="rounded-md border border-sky-900 bg-sky-950/40 px-3 py-1.5 text-xs text-sky-300">
            MOCK 模式（無引擎連線）：佈局變更僅本地預覽，不會送出至伺服器。
          </p>
        )}
        <LayoutEditorPanel send={send} />
      </div>

      <div role="tabpanel" className={tab === "agents" ? "block" : "hidden"}>
        <AgentPanel />
      </div>

      <footer className="text-xs text-slate-600">
        佈局編輯器已可編譯與顯示（深度編輯體驗與世界設定於 Phase 3 wave 3 完成）；
        角色設定面板目前為唯讀檢視，編輯功能於 wave 3 開通；agent 認知（LLM）於 Phase 2 接入。
      </footer>
    </main>
  );
}
