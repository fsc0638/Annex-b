"use client";

// ADR-002 D6/D5 minimal "角色設定" tab: read-only listing of the 9 seed
// agents' customization-relevant fields (name/title/grade/seed_traits/
// reply_style/llm_profile). Phase 3 wave 3 turns this into an editor that
// PATCHes /api/v1/agents/:id — this wave only needs it to compile and
// display so the tab isn't empty.

import { useGameStore } from "@/game/store";

export default function AgentPanel() {
  const agents = useGameStore((state) => state.agents);
  const conn = useGameStore((state) => state.conn);

  const agentsList = Object.values(agents).sort((a, b) =>
    a.name.localeCompare(b.name, "zh-Hant")
  );

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-semibold text-slate-100">角色設定</h2>
        <span className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-500">
          編輯功能第三波開通
        </span>
      </div>

      {conn === "mock" && (
        <p className="mb-2 rounded-md border border-sky-900 bg-sky-950/40 px-2 py-1.5 text-xs text-sky-300">
          MOCK 模式（無引擎連線）：以下為靜態快照的唯讀檢視。
        </p>
      )}

      {agentsList.length === 0 ? (
        <p className="text-xs text-slate-500">等待世界快照…</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-xs">
            <thead>
              <tr className="text-slate-400">
                <th className="border-b border-slate-800 px-2 py-1.5 font-medium">姓名</th>
                <th className="border-b border-slate-800 px-2 py-1.5 font-medium">職稱</th>
                <th className="border-b border-slate-800 px-2 py-1.5 font-medium">職等</th>
                <th className="border-b border-slate-800 px-2 py-1.5 font-medium">
                  個性（seed_traits）
                </th>
                <th className="border-b border-slate-800 px-2 py-1.5 font-medium">回覆方式</th>
                <th className="border-b border-slate-800 px-2 py-1.5 font-medium">
                  LLM 逐層覆寫
                </th>
              </tr>
            </thead>
            <tbody>
              {agentsList.map((agent) => {
                const overrides = Object.entries(agent.llm_profile ?? {});
                return (
                  <tr key={agent.id} className="align-top text-slate-300">
                    <td className="border-b border-slate-900 px-2 py-1.5 font-medium text-slate-100">
                      {agent.name}
                    </td>
                    <td className="border-b border-slate-900 px-2 py-1.5">{agent.title}</td>
                    <td className="border-b border-slate-900 px-2 py-1.5">{agent.grade}</td>
                    <td className="border-b border-slate-900 px-2 py-1.5">{agent.seed_traits}</td>
                    <td className="border-b border-slate-900 px-2 py-1.5">
                      {agent.reply_style ?? (
                        <span className="text-slate-600">（未設定）</span>
                      )}
                    </td>
                    <td className="border-b border-slate-900 px-2 py-1.5">
                      {overrides.length > 0 ? (
                        overrides.map(([tier, model]) => (
                          <div key={tier}>
                            {tier}：{model}
                          </div>
                        ))
                      ) : (
                        <span className="text-slate-600">（使用預設）</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
