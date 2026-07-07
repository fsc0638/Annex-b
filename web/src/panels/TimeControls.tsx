"use client";

// Time control bar (spec 7.1-2, Phase 1 subset): pause/play, x1/x2/x5,
// game day + clock. The edit-mode toggle arrives in Phase 3. UI text is
// zh-TW per spec 0.1 rule 8.

import { useGameStore } from "@/game/store";
import { formatClock } from "@/game/types";

export interface TimeControlsProps {
  /** null in mock mode (no engine connection) — controls are disabled. */
  send: ((payload: unknown) => void) | null;
}

const SPEEDS = [1, 2, 5] as const;

export default function TimeControls({ send }: TimeControlsProps) {
  const world = useGameStore((s) => s.world);
  const running = useGameStore((s) => s.running);
  const speed = useGameStore((s) => s.speed);
  const conn = useGameStore((s) => s.conn);
  const lastError = useGameStore((s) => s.lastError);
  const clearError = useGameStore((s) => s.clearError);

  const disabled = send === null || conn === "mock";

  const connLabel: Record<string, string> = {
    connecting: "連線中…",
    open: "已連線",
    closed: "已斷線，自動重連中…",
    mock: "MOCK 模式（靜態快照）",
  };
  const connColor: Record<string, string> = {
    connecting: "text-amber-400",
    open: "text-emerald-400",
    closed: "text-rose-400",
    mock: "text-sky-400",
  };

  return (
    <div className="flex w-full flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900 px-4 py-2 text-slate-100">
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          send?.({ type: "control", action: running ? "pause" : "resume" })
        }
        className="rounded-md bg-slate-700 px-4 py-1.5 text-sm font-medium hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {running ? "⏸ 暫停" : "▶ 播放"}
      </button>

      <div className="flex items-center gap-1" role="group" aria-label="模擬速度">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => send?.({ type: "control", action: "set_speed", speed: s })}
            className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
              speed === s
                ? "bg-indigo-600 text-white"
                : "bg-slate-700 hover:bg-slate-600"
            }`}
          >
            x{s}
          </button>
        ))}
      </div>

      <div className="ml-2 font-mono text-lg tabular-nums">
        {world ? (
          <>
            <span className="text-slate-400">第 {world.sim_day} 天</span>{" "}
            <span>{formatClock(world.sim_clock_sec)}</span>
          </>
        ) : (
          <span className="text-slate-500">等待世界快照…</span>
        )}
      </div>

      <div className={`ml-auto text-sm ${connColor[conn]}`}>{connLabel[conn]}</div>

      {lastError && (
        <button
          type="button"
          onClick={clearError}
          title="點擊關閉"
          className="w-full rounded-md border border-rose-800 bg-rose-950 px-3 py-1 text-left text-sm text-rose-300"
        >
          伺服器訊息：{lastError}（點擊關閉）
        </button>
      )}
    </div>
  );
}
