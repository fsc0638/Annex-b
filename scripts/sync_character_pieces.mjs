#!/usr/bin/env node
// sync_character_pieces.mjs — copies the purchased LimeZu "Character
// Generator 2.0" ADULT layered part sheets (Bodies/Eyes/Hairstyles/Outfits/
// Accessories, 32x32 canvas variant only) into web/public/character/ and
// writes a manifest the browser-side compositor (ADR-003 D3) reads.
//
// Companion to scripts/sync_limezu_assets.mjs (furniture) — same shape of
// script (SKIP-not-crash when the paid source isn't on disk, deterministic
// iteration, safeJoin path guard) but for character parts instead of
// furniture singles. Kept as a SEPARATE script (not folded into
// sync_limezu_assets.mjs) because it targets a structurally different
// source layout (layered animation sheets, not flat furniture singles) and
// a different output contract (web/public/character/, not
// web/public/tilesets/).
//
// What is copied: only the ADULT 32x32 pieces. Explicitly excluded (ADR-003
// "不做" section):
//   - `*_kids` sibling folders (Bodies_kids, Eyes_kids, Hairstyles_kids,
//     Outfits_kids) — not scanned at all.
//   - 16x16 / 48x48 canvas variants — only the `32x32/` subfolder per piece
//     type is scanned.
// A stray non-conforming file (observed on the purchased package: a
// duplicate-looking "Body_01 69.png" alongside "Body_01.png", byte-identical
// to it — almost certainly a macOS Finder "keep both" artifact from
// unzipping) is silently skipped by the strict per-layer filename regexes
// below rather than crashing the scan; see the printed NOTE line.
//
// Idempotent: re-running overwrites the same deterministic output
// (piece ids/filenames/manifest are pure functions of the source directory
// listing, sorted before use).

import { access, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CHAR_FRAME, WALK_DIRS, walkFrameRects } from "../web/src/lib/character_frames.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const assetsRoot = path.join(repoRoot, "assets", "tilesets", "limezu-modern-office");
const publicDir = path.join(repoRoot, "web", "public", "character");
const manifestPath = path.join(publicDir, "manifest.json");

// Two known on-disk locations for the same Character Generator 2.0 part
// sheets (ADR-003: "也可用 moderninteriors-win 內同名部件（重複，擇一）").
// Primary is tried first; secondary is a fallback if primary is absent
// (e.g. a future re-export of the purchased bundle only includes one of
// the two vendor folders).
const CANDIDATE_ROOTS = [
  path.join(
    assetsRoot,
    "Character Generator 2.0 Linux Build",
    "Character Generator 2.0 Linux Build",
    "Character Pieces"
  ),
  path.join(assetsRoot, "moderninteriors-win", "2_Characters", "Character_Generator"),
];

const args = new Set(process.argv.slice(2));
const requireAssets = args.has("--require");

function logSkip(message) {
  console.log(`[character] SKIP: ${message}`);
  if (requireAssets) {
    process.exitCode = 1;
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeJoin(base, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Expected a relative character asset path, got "${relativePath}"`);
  }
  const full = path.resolve(base, relativePath);
  const normalizedBase = path.resolve(base) + path.sep;
  if (!full.startsWith(normalizedBase)) {
    throw new Error(`Refusing to touch outside ${base}: ${relativePath}`);
  }
  return full;
}

// --- Per-layer scan config ------------------------------------------------
//
// `dir`: source subfolder name under <root>/ (adult 32x32 only — `_kids`
// siblings are simply never listed here).
// `match`: strict filename regex; a source file that doesn't match is
// skipped with a NOTE (never crashes the scan) rather than guessed at.
// `build(match)`: turns a regex match into {id, label} — `id` doubles as
// the copied file's basename (id + ".png") so file/manifest ids never
// diverge.
const LAYERS = [
  {
    key: "body",
    dir: "Bodies",
    label: "身體",
    match: /^Body_(\d+)\.png$/i,
    build: (m) => ({ id: `body-${m[1]}`, label: `身體 ${m[1]}` }),
  },
  {
    key: "eyes",
    dir: "Eyes",
    label: "眼睛",
    match: /^Eyes_(\d+)\.png$/i,
    build: (m) => ({ id: `eyes-${m[1]}`, label: `眼睛 ${m[1]}` }),
  },
  {
    key: "hairstyle",
    dir: "Hairstyles",
    label: "髮型",
    match: /^Hairstyle_(\d+)_(\d+)\.png$/i,
    build: (m) => ({ id: `hairstyle-${m[1]}-${m[2]}`, label: `髮型 ${m[1]}-${m[2]}` }),
  },
  {
    key: "outfit",
    dir: "Outfits",
    label: "服裝",
    match: /^Outfit_(\d+)_(\d+)\.png$/i,
    build: (m) => ({ id: `outfit-${m[1]}-${m[2]}`, label: `服裝 ${m[1]}-${m[2]}` }),
  },
  {
    key: "accessory",
    dir: "Accessories",
    label: "配件",
    // Middle group is a free-text descriptive name that may itself contain
    // underscores (e.g. "Dino_Snapback", "Policeman_Hat") — the greedy
    // `.+` correctly grabs everything between the leading and trailing
    // numeric groups because the trailing `_(\d+)\.png$` anchors at the end.
    match: /^Accessory_(\d+)_(.+)_(\d+)\.png$/i,
    build: (m) => {
      const slug = m[2].toLowerCase().replace(/_/g, "-");
      const niceName = m[2].replace(/_/g, " ");
      return {
        id: `accessory-${m[1]}-${slug}-${m[3]}`,
        label: `配件 ${m[1]} ${niceName}-${m[3]}`,
      };
    },
  },
];

async function findSourceRoot() {
  for (const root of CANDIDATE_ROOTS) {
    if (await exists(root)) return root;
  }
  return null;
}

async function scanLayer(root, layer) {
  const dir = path.join(root, layer.dir, "32x32");
  if (!(await exists(dir))) {
    console.log(`[character] NOTE: ${layer.key} source not found (${dir}) — skipping this layer.`);
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".png"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const pieces = [];
  let skipped = 0;
  for (const name of files) {
    const m = name.match(layer.match);
    if (!m) {
      skipped++;
      continue;
    }
    const { id, label } = layer.build(m);
    pieces.push({
      id,
      label,
      sourceFile: path.join(dir, name),
      file: `/character/${layer.key}/${id}.png`,
    });
  }
  if (skipped > 0) {
    console.log(
      `[character] NOTE: ${layer.key}: ${skipped} file(s) did not match the expected naming ` +
        `pattern and were skipped (e.g. a stray duplicate export) — not an error.`
    );
  }
  console.log(`[character]   ${layer.key} (${layer.label}): ${pieces.length} piece(s)`);
  return pieces;
}

async function copyLayer(layer, pieces) {
  if (pieces.length === 0) return;
  const targetDir = safeJoin(publicDir, layer.key);
  await mkdir(targetDir, { recursive: true });
  await Promise.all(
    pieces.map(async (piece) => {
      const targetFile = safeJoin(publicDir, `${layer.key}/${piece.id}.png`);
      await copyFile(piece.sourceFile, targetFile);
    })
  );
}

async function main() {
  const sourceRoot = await findSourceRoot();
  if (!sourceRoot) {
    logSkip(
      `No LimeZu "Character Generator 2.0" Character Pieces folder found under ${assetsRoot}.\n` +
        `  This is expected until the purchased character-generator package is placed on disk —\n` +
        `  see assets/README.md ("LimeZu 購買與放置說明"). Expected one of:\n` +
        CANDIDATE_ROOTS.map((r) => `    ${r}/<Bodies|Eyes|Hairstyles|Outfits|Accessories>/32x32/`).join(
          "\n"
        ) +
        `\n  Until then, agent appearance stays null (the existing generated placeholder sprite is used).`
    );
    return;
  }
  console.log(`[character] source: ${sourceRoot}`);

  const layers = {};
  for (const layer of LAYERS) {
    layers[layer.key] = await scanLayer(sourceRoot, layer);
  }

  const totalPieces = Object.values(layers).reduce((sum, arr) => sum + arr.length, 0);
  if (totalPieces === 0) {
    logSkip(`Found ${sourceRoot} but no layer subfolder yielded any matching 32x32 PNG.`);
    return;
  }

  await mkdir(publicDir, { recursive: true });
  for (const layer of LAYERS) {
    await copyLayer(layer, layers[layer.key]);
  }

  // Manifest: piece catalog per layer (id/file/label only — sourceFile is a
  // local scan detail, not part of the public contract) + the shared walk
  // frame geometry (character_frames.ts is the single source of truth;
  // this just re-exports its computed values so a consumer that only reads
  // manifest.json — no JS bundle — still gets the coordinates).
  const manifest = {
    layers: Object.fromEntries(
      LAYERS.map((layer) => [
        layer.key,
        layers[layer.key].map(({ id, file, label }) => ({ id, file, label })),
      ])
    ),
    frame: { w: CHAR_FRAME.w, h: CHAR_FRAME.h },
    walk: Object.fromEntries(WALK_DIRS.map((dir) => [dir, walkFrameRects(dir)])),
    generatedFrom: `${path.relative(repoRoot, sourceRoot)} (scanned: adult 32x32 Character Pieces)`,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const perLayerCounts = LAYERS.map((l) => `${l.key}=${layers[l.key].length}`).join(", ");
  console.log(
    `[character] OK: ${totalPieces} piece(s) copied (${perLayerCounts}); wrote ${manifestPath}`
  );
}

main().catch((err) => {
  console.error(`[character] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
