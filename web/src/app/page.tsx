"use client";

// Phase 1 main view: office canvas + time controls.
//
// Normal mode connects to the engine's /ws; every (re)connect receives a
// world_snapshot that fully restores the client state (furniture layer
// included). NEXT_PUBLIC_MOCK_SNAPSHOT=1 skips the WebSocket entirely and
// renders the static fixture snapshot from /mock/world_snapshot.json —
// useful for UI work on machines without a running engine.

import { useEffect, useRef, useState } from "react";
import OfficeCanvas from "@/game/OfficeCanvas";
import TimeControls from "@/panels/TimeControls";
import { useGameStore } from "@/game/store";
import type { WorldSnapshotMsg } from "@/game/types";
import { connectWs, wsUrl, type WsClient } from "@/ws/client";

const MOCK_MODE = process.env.NEXT_PUBLIC_MOCK_SNAPSHOT === "1";

export default function Home() {
  const clientRef = useRef<WsClient | null>(null);
  const [send, setSend] = useState<((payload: unknown) => void) | null>(null);

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
      <TimeControls send={send} />
      <OfficeCanvas />
      <footer className="text-xs text-slate-600">
        佈局編輯器與觀測面板將於 Phase 3 加入；agent 認知（LLM）於 Phase 2 接入。
      </footer>
    </main>
  );
}
