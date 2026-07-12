"use client";

// ADR-002 D5/D6 "角色設定" tab: per-agent customization editor.
// Opens an inline form per row to edit name / seed_traits (個性) /
// core_identity (風格·人設全文) / reply_style (回覆方式) / llm_profile
// (L1-L3 per-tier model override). Saves via `PATCH /api/v1/agents/:id`
// (only changed top-level fields are sent; llm_profile is sent whole
// because the engine replaces it wholesale, see
// sim-core::world::WorldState::patch_agent) and reconciles the store with
// the full `world_snapshot` the engine replies with — PATCH does not reset
// the world, so no confirmation dialog is needed before saving (unlike the
// two `PUT /world/...` endpoints).
//
// Spec red line (ADR-002 D5 / 規格書 §5.3 附錄A): only these five fields
// are ever exposed. No "服從/敵對/關係" control may be added here.

import { Fragment, useEffect, useRef, useState } from "react";
import { apiJson, ApiError } from "@/api/client";
import { useGameStore } from "@/game/store";
import {
  CHARACTER_LAYER_ORDER,
  type AgentRow,
  type AppearanceLayers,
  type CharacterLayerKey,
  type WorldSnapshotMsg,
} from "@/game/types";
import {
  compositeCharacter,
  isEmptyAppearance,
  normalizeAppearance,
  standingFrameRect,
} from "@/lib/character_compositor";
import { CHAR_FRAME } from "@/lib/character_frames";

// ADR-003 D3: display order/labels for the "外觀" editor's 5 layer
// dropdowns — reuses CHARACTER_LAYER_ORDER (the compositing stack order)
// as the display order too, since there's no reason for them to diverge.
const LAYER_LABELS: Record<CharacterLayerKey, string> = {
  body: "身體",
  eyes: "眼睛",
  outfit: "服裝",
  hairstyle: "髮型",
  accessory: "配件",
};

type TierKey = "L1" | "L2" | "L3";
const TIERS: TierKey[] = ["L1", "L2", "L3"];

const LLM_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "跟隨預設（不覆寫）" },
  { value: "anthropic:claude-sonnet-5", label: "anthropic:claude-sonnet-5" },
  {
    value: "anthropic:claude-haiku-4-5-20251001",
    label: "anthropic:claude-haiku-4-5-20251001",
  },
  { value: "openai:gpt-4o", label: "openai:gpt-4o" },
  { value: "openai:gpt-4o-mini", label: "openai:gpt-4o-mini" },
];
const CUSTOM_OPTION = "__custom__";
// Kept in sync with the engine's provider allowlist minus "mock" (that
// provider is an internal test fixture, not something an operator should
// be able to select from the UI) — see
// engine/crates/api-server/src/agents_api.rs::validate_llm_profile.
const LLM_PROFILE_PATTERN = /^(anthropic|openai|gemini|ollama):.+$/;

interface AgentFormState {
  name: string;
  seedTraits: string;
  coreIdentity: string;
  replyStyle: string;
  llmProfile: Record<TierKey, string>;
  /** `null` = "use the generated placeholder sprite" (ADR-003 D3). A
   * present object may be partial (missing keys read as "無" in the
   * dropdowns, same as an explicit `null` value) — see `AgentRow.
   * appearance`'s doc comment. */
  appearance: AppearanceLayers | null;
}

function buildForm(agent: AgentRow): AgentFormState {
  const llmProfile = { L1: "", L2: "", L3: "" } as Record<TierKey, string>;
  for (const t of TIERS) {
    llmProfile[t] = agent.llm_profile?.[t] ?? "";
  }
  return {
    name: agent.name,
    seedTraits: agent.seed_traits,
    coreIdentity: agent.core_identity,
    replyStyle: agent.reply_style ?? "",
    llmProfile,
    appearance: agent.appearance ?? null,
  };
}

/** `appearance` equality for dirty-checking / patch-building, treating
 * `null` and "an object whose layers are all null/absent" as the SAME
 * state (both render as the placeholder sprite — see `isEmptyAppearance`)
 * so toggling every dropdown back to "無" by hand doesn't falsely count as
 * a change from an agent that already had `appearance: null`. */
function appearancesEqual(a: AppearanceLayers | null, b: AppearanceLayers | null): boolean {
  const aEmpty = isEmptyAppearance(a);
  const bEmpty = isEmptyAppearance(b);
  if (aEmpty || bEmpty) return aEmpty === bEmpty;
  return JSON.stringify(normalizeAppearance(a)) === JSON.stringify(normalizeAppearance(b));
}

/** Canonical string for a (partial) llm_profile object, for equality checks
 * independent of key insertion order. */
function canonicalProfile(p: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(p)
      .sort()
      .map((k) => [k, p[k]])
  );
}

/** Only the fields that actually differ from `agent`, ready to PATCH.
 * `llm_profile` is all-or-nothing: if any tier changed, the whole
 * non-empty-tier object is sent (the engine replaces it wholesale). */
function buildPatch(agent: AgentRow, form: AgentFormState): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const trimmedName = form.name.trim();
  if (trimmedName !== agent.name) patch.name = trimmedName;
  if (form.seedTraits !== agent.seed_traits) patch.seed_traits = form.seedTraits;
  if (form.coreIdentity !== agent.core_identity) patch.core_identity = form.coreIdentity;

  const originalReplyStyle = agent.reply_style ?? "";
  if (form.replyStyle !== originalReplyStyle) patch.reply_style = form.replyStyle;

  const nextProfile: Record<string, string> = {};
  for (const t of TIERS) {
    if (form.llmProfile[t]) nextProfile[t] = form.llmProfile[t];
  }
  const originalProfile = agent.llm_profile ?? {};
  if (canonicalProfile(nextProfile) !== canonicalProfile(originalProfile)) {
    patch.llm_profile = nextProfile;
  }

  // ADR-003 D3: "appearance 整包送或 null" — never a bare partial object,
  // so the engine's stored value is always exactly what the 5 dropdowns
  // showed at save time (no ambiguity about which keys were "unchanged").
  if (!appearancesEqual(form.appearance, agent.appearance ?? null)) {
    patch.appearance = isEmptyAppearance(form.appearance)
      ? null
      : normalizeAppearance(form.appearance);
  }

  return patch;
}

function tierError(raw: string): string | null {
  if (raw === "") return null;
  return LLM_PROFILE_PATTERN.test(raw)
    ? null
    : "格式須為 provider:model（provider 限 anthropic/openai/gemini/ollama）";
}

function formHasErrors(form: AgentFormState): boolean {
  if (form.name.trim() === "") return true;
  return TIERS.some((t) => tierError(form.llmProfile[t]) !== null);
}

export default function AgentPanel() {
  const agents = useGameStore((state) => state.agents);
  const conn = useGameStore((state) => state.conn);
  // ADR-003 D3: same store-shared manifest pattern as furnitureManifest —
  // `ensureCharacterManifestLoaded` is idempotent, so it's safe to call
  // from this panel's mount even if OfficeCanvas already kicked off (or
  // finished) the same fetch.
  const characterManifest = useGameStore((state) => state.characterManifest);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AgentFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const readOnly = conn === "mock";

  useEffect(() => {
    useGameStore.getState().ensureCharacterManifestLoaded();
  }, []);

  // Live appearance preview: recomposites (via the same cache OfficeCanvas
  // uses) whenever the edited form's appearance selection or the manifest
  // itself changes, and draws the "down, standing" frame into the preview
  // canvas at 3x scale (pixelated — imageSmoothingEnabled off). Clears the
  // canvas (and lets the "使用預設佔位角色" caption take over, see JSX
  // below) for an empty/default appearance instead of drawing anything.
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!form || isEmptyAppearance(form.appearance)) return;
    let cancelled = false;
    void compositeCharacter(form.appearance, characterManifest).then((sheet) => {
      if (cancelled || !sheet) return;
      const liveCanvas = previewCanvasRef.current;
      const liveCtx = liveCanvas?.getContext("2d");
      if (!liveCanvas || !liveCtx) return;
      liveCtx.imageSmoothingEnabled = false;
      liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
      const rect = standingFrameRect("down");
      liveCtx.drawImage(
        sheet,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        0,
        0,
        liveCanvas.width,
        liveCanvas.height
      );
    });
    return () => {
      cancelled = true;
    };
    // Intentionally NOT depending on the whole `form` object: every other
    // field (name/seedTraits/...) also creates a new `form` reference on
    // each keystroke, which would re-run this effect (and redundantly
    // re-hit compositeCharacter's cache) on every unrelated edit. Only
    // `form.appearance`'s own identity (which `updateAppearanceLayer`/
    // `resetAppearance` change) and the manifest matter for what gets
    // drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.appearance, characterManifest]);

  function updateAppearanceLayer(layer: CharacterLayerKey, pieceId: string) {
    setForm((prev) => {
      if (!prev) return prev;
      const next = { ...normalizeAppearance(prev.appearance) };
      next[layer] = pieceId === "" ? null : pieceId;
      return { ...prev, appearance: next };
    });
  }

  function resetAppearance() {
    setForm((prev) => (prev ? { ...prev, appearance: null } : prev));
  }

  const agentsList = Object.values(agents).sort((a, b) =>
    a.name.localeCompare(b.name, "zh-Hant")
  );

  function isDirty(agentId: string, f: AgentFormState): boolean {
    const agent = agents[agentId];
    if (!agent) return false;
    return Object.keys(buildPatch(agent, f)).length > 0;
  }

  function closeEdit(skipConfirm: boolean) {
    if (!skipConfirm && editingId && form && isDirty(editingId, form)) {
      if (!window.confirm("目前的編輯尚未儲存，確定要放棄變更嗎？")) return;
    }
    setEditingId(null);
    setForm(null);
    setFormError(null);
  }

  function openEdit(agentId: string) {
    if (editingId === agentId) {
      closeEdit(false);
      return;
    }
    if (editingId && form && isDirty(editingId, form)) {
      if (!window.confirm("目前的編輯尚未儲存，確定要放棄並切換到其他角色嗎？")) return;
    }
    const agent = agents[agentId];
    if (!agent) return;
    setEditingId(agentId);
    setForm(buildForm(agent));
    setFormError(null);
  }

  function handleRevert() {
    if (!editingId) return;
    const agent = agents[editingId];
    if (!agent) return;
    setForm(buildForm(agent));
    setFormError(null);
  }

  function updateField<K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function updateTier(tier: TierKey, value: string) {
    setForm((prev) =>
      prev ? { ...prev, llmProfile: { ...prev.llmProfile, [tier]: value } } : prev
    );
  }

  async function handleSave() {
    if (!editingId || !form) return;
    const agent = agents[editingId];
    if (!agent) return;

    if (formHasErrors(form)) {
      setFormError("表單有錯誤，請修正後再儲存");
      return;
    }
    const patch = buildPatch(agent, form);
    if (Object.keys(patch).length === 0) {
      closeEdit(true);
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const snapshot = await apiJson<WorldSnapshotMsg>(`/api/v1/agents/${editingId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      useGameStore.getState().applyServerMsg(snapshot);
      closeEdit(true);
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "儲存失敗，請稍後再試"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-semibold text-slate-100">角色設定</h2>
      </div>

      {readOnly && (
        <p className="mb-2 rounded-md border border-sky-900 bg-sky-950/40 px-2 py-1.5 text-xs text-sky-300">
          MOCK 模式（無引擎連線）：以下為靜態快照的唯讀檢視，無法編輯。
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
                <th className="border-b border-slate-800 px-2 py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {agentsList.map((agent) => {
                const overrides = Object.entries(agent.llm_profile ?? {});
                const isEditing = editingId === agent.id;
                return (
                  <Fragment key={agent.id}>
                    <tr className="align-top text-slate-300">
                      <td className="border-b border-slate-900 px-2 py-1.5 font-medium text-slate-100">
                        {agent.name}
                      </td>
                      <td className="border-b border-slate-900 px-2 py-1.5">{agent.title}</td>
                      <td className="border-b border-slate-900 px-2 py-1.5">{agent.grade}</td>
                      <td className="border-b border-slate-900 px-2 py-1.5">
                        {agent.seed_traits}
                      </td>
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
                      <td className="border-b border-slate-900 px-2 py-1.5">
                        <button
                          type="button"
                          disabled={readOnly}
                          onClick={() => openEdit(agent.id)}
                          className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {isEditing ? "收合" : "編輯"}
                        </button>
                      </td>
                    </tr>
                    {isEditing && form && (
                      <tr className="bg-slate-950/60">
                        <td colSpan={7} className="border-b border-slate-800 px-3 py-3">
                          <fieldset disabled={saving} className="grid gap-3">
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                              <label className="block text-xs">
                                <span className="mb-1 block font-medium text-slate-200">
                                  姓名
                                </span>
                                <input
                                  type="text"
                                  value={form.name}
                                  onChange={(e) => updateField("name", e.target.value)}
                                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100"
                                />
                                {form.name.trim() === "" && (
                                  <span className="mt-1 block text-[11px] text-rose-400">
                                    姓名不得為空
                                  </span>
                                )}
                              </label>

                              <div className="block text-xs">
                                <span className="mb-1 block font-medium text-slate-200">
                                  職級 / 職稱（唯讀）
                                </span>
                                <div className="rounded-md border border-slate-800 bg-slate-900/50 px-2 py-1.5 text-slate-400">
                                  {agent.grade} ・ {agent.title}
                                </div>
                              </div>

                              <label className="block text-xs sm:col-span-2">
                                <span className="mb-1 block font-medium text-slate-200">
                                  個性（seed_traits）
                                </span>
                                <span className="mb-1 block text-[11px] text-slate-500">
                                  這名角色的個性特徵，會影響決策與對話風格。
                                </span>
                                <input
                                  type="text"
                                  value={form.seedTraits}
                                  onChange={(e) => updateField("seedTraits", e.target.value)}
                                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100"
                                />
                              </label>

                              <label className="block text-xs sm:col-span-2">
                                <span className="mb-1 block font-medium text-slate-200">
                                  風格與人設全文（core_identity）
                                </span>
                                <span className="mb-1 block text-[11px] text-slate-500">
                                  完整的人設描述文字，會注入對話 prompt 的角色設定。
                                </span>
                                <textarea
                                  rows={4}
                                  value={form.coreIdentity}
                                  onChange={(e) => updateField("coreIdentity", e.target.value)}
                                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100"
                                />
                              </label>

                              <label className="block text-xs sm:col-span-2">
                                <span className="mb-1 block font-medium text-slate-200">
                                  回覆方式（reply_style）
                                </span>
                                <span className="mb-1 block text-[11px] text-slate-500">
                                  這名角色回覆訊息的方式與語氣，會注入對話 prompt。
                                </span>
                                <textarea
                                  rows={3}
                                  value={form.replyStyle}
                                  onChange={(e) => updateField("replyStyle", e.target.value)}
                                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100"
                                />
                              </label>
                            </div>

                            <div>
                              <span className="mb-1 block text-xs font-medium text-slate-200">
                                LLM 逐層模型覆寫
                              </span>
                              <span className="mb-2 block text-[11px] text-slate-500">
                                每層可個別指定模型，留空則跟隨系統預設。L0
                                由引擎固定，不開放覆寫。
                              </span>
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                {TIERS.map((tier) => {
                                  const raw = form.llmProfile[tier];
                                  const isPreset = LLM_PRESETS.some((p) => p.value === raw);
                                  const selectValue = isPreset ? raw : CUSTOM_OPTION;
                                  const err = tierError(raw);
                                  return (
                                    <div key={tier} className="text-xs">
                                      <span className="mb-1 block font-medium text-slate-300">
                                        {tier}
                                      </span>
                                      <select
                                        value={selectValue}
                                        onChange={(e) => {
                                          const v = e.target.value;
                                          updateTier(tier, v === CUSTOM_OPTION ? raw : v);
                                        }}
                                        className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100"
                                      >
                                        {LLM_PRESETS.map((p) => (
                                          <option key={p.value || "default"} value={p.value}>
                                            {p.label}
                                          </option>
                                        ))}
                                        <option value={CUSTOM_OPTION}>自訂…</option>
                                      </select>
                                      {selectValue === CUSTOM_OPTION && (
                                        <input
                                          type="text"
                                          placeholder="provider:model"
                                          value={raw}
                                          onChange={(e) => updateTier(tier, e.target.value)}
                                          className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100"
                                        />
                                      )}
                                      {err && (
                                        <span className="mt-1 block text-[11px] text-rose-400">
                                          {err}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>

                            <details className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
                              <summary className="cursor-pointer text-xs font-medium text-slate-200">
                                外觀
                              </summary>
                              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                  {CHARACTER_LAYER_ORDER.map((layer) => {
                                    const pieces = characterManifest?.layers[layer] ?? [];
                                    const value = form.appearance?.[layer] ?? "";
                                    return (
                                      <label key={layer} className="block text-xs">
                                        <span className="mb-1 block font-medium text-slate-300">
                                          {LAYER_LABELS[layer]}
                                        </span>
                                        <select
                                          value={value}
                                          disabled={!characterManifest}
                                          onChange={(e) =>
                                            updateAppearanceLayer(layer, e.target.value)
                                          }
                                          className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                          <option value="">無</option>
                                          {pieces.map((piece) => (
                                            <option key={piece.id} value={piece.id}>
                                              {piece.label}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                    );
                                  })}
                                  {!characterManifest && (
                                    <p className="text-[11px] text-slate-500 sm:col-span-2">
                                      角色部件素材尚未同步，外觀選項暫不可用（畫面沿用預設佔位角色）。
                                    </p>
                                  )}
                                  <div className="sm:col-span-2">
                                    <button
                                      type="button"
                                      onClick={resetAppearance}
                                      className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
                                    >
                                      還原預設外觀
                                    </button>
                                  </div>
                                </div>
                                <div className="flex flex-col items-center gap-1">
                                  <span className="text-[11px] text-slate-500">預覽</span>
                                  <canvas
                                    ref={previewCanvasRef}
                                    width={CHAR_FRAME.w * 3}
                                    height={CHAR_FRAME.h * 3}
                                    style={{ imageRendering: "pixelated" }}
                                    className="rounded-md border border-slate-700 bg-slate-900"
                                  />
                                  {isEmptyAppearance(form.appearance) && (
                                    <span className="w-24 text-center text-[11px] text-slate-600">
                                      使用預設佔位角色
                                    </span>
                                  )}
                                </div>
                              </div>
                            </details>

                            {formError && (
                              <p className="rounded-md border border-rose-800 bg-rose-950/50 px-2 py-1.5 text-[11px] text-rose-300">
                                {formError}
                              </p>
                            )}

                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={handleSave}
                                disabled={saving || formHasErrors(form)}
                                className="rounded-md bg-indigo-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {saving ? "儲存中…" : "儲存"}
                              </button>
                              <button
                                type="button"
                                onClick={handleRevert}
                                disabled={saving}
                                className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                還原
                              </button>
                              <button
                                type="button"
                                onClick={() => closeEdit(false)}
                                disabled={saving}
                                className="ml-auto rounded-md border border-slate-700 px-3 py-1.5 text-[11px] font-medium text-slate-400 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                取消
                              </button>
                            </div>
                          </fieldset>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
