// Reconnecting WebSocket client (Phase 1 T1.4).
//
// - On every (re)connect the server sends a fresh world_snapshot, which
//   fully replaces the store state — reconnection therefore restores the
//   world (including the furniture layer) with no extra client logic.
// - Backoff: 1s, 2s, 5s, then 5s forever; reset on successful open.

import type { ServerMsg } from "@/game/types";

export interface WsHandlers {
  onMessage: (msg: ServerMsg) => void;
  onStatus: (status: "connecting" | "open" | "closed") => void;
}

export interface WsClient {
  send: (payload: unknown) => void;
  close: () => void;
}

const BACKOFF_MS = [1000, 2000, 5000];

export function wsUrl(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";
  return base.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
}

export function connectWs(url: string, handlers: WsHandlers): WsClient {
  let socket: WebSocket | null = null;
  let attempts = 0;
  let closedByUser = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    handlers.onStatus("connecting");
    socket = new WebSocket(url);
    socket.onopen = () => {
      attempts = 0;
      handlers.onStatus("open");
    };
    socket.onmessage = (ev) => {
      try {
        handlers.onMessage(JSON.parse(ev.data as string) as ServerMsg);
      } catch {
        // Non-JSON frame: ignore (protocol is JSON-only).
      }
    };
    socket.onclose = () => {
      socket = null;
      if (closedByUser) return;
      handlers.onStatus("closed");
      const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
      attempts += 1;
      retryTimer = setTimeout(open, delay);
    };
    socket.onerror = () => {
      // onclose fires after onerror; reconnect logic lives there.
      socket?.close();
    };
  };

  open();

  return {
    send: (payload: unknown) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    },
    close: () => {
      closedByUser = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
