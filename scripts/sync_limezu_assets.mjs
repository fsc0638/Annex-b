#!/usr/bin/env node

import { access, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "assets", "tilesets", "limezu-modern-office");
const publicDir = path.join(repoRoot, "web", "public", "tilesets", "limezu-modern-office");
const publicManifestPath = path.join(publicDir, "manifest.json");

// Source A (ADR-002): Modern Office Revamped's 32x32 furniture singles.
const officeSourceDir = path.join(
  sourceDir,
  "Modern_Office_Revamped_v1.2",
  "4_Modern_Office_singles",
  "32x32"
);
// Source B (ADR-003 D1): Modern Interiors' theme-sorter singles. Only the
// 32x32, standard-shadow "Singles" variant is scanned — NOT 16x16/48x48
// and NOT the Black_Shadow/Shadowless duplicates (ADR-003 "不做" section);
// those are ~10x visually-identical duplicates of what's scanned here.
const themeSorterDir = path.join(
  sourceDir,
  "moderninteriors-win",
  "1_Interiors",
  "32x32",
  "Theme_Sorter_Singles_32x32"
);

const args = new Set(process.argv.slice(2));
const requireAssets = args.has("--require");

function logSkip(message) {
  console.log(`[limezu] SKIP: ${message}`);
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
    throw new Error(`Expected a relative LimeZu asset path, got "${relativePath}"`);
  }
  const full = path.resolve(base, relativePath);
  const normalizedBase = path.resolve(base) + path.sep;
  if (!full.startsWith(normalizedBase)) {
    throw new Error(`Refusing to touch outside ${base}: ${relativePath}`);
  }
  return full;
}

function toPublicUrl(relativePath) {
  return `/tilesets/limezu-modern-office/${relativePath.replace(/\\/g, "/")}`;
}

// Every source file in both Source A and Source B is named "..._<N>.png"
// — this trailing number is the only stable per-item key either vendor
// folder gives us, so both sources share this one extractor.
function singleNumber(fileName) {
  const match = fileName.match(/_(\d+)\.png$/i);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function pad3(num) {
  return String(num).padStart(3, "0");
}

// --- Source A: Office singles (category "office") ---------------------

// Unchanged from ADR-002's version — ranges hand-tuned against the 339
// Modern_Office_Singles_32x32_<N>.png files.
function inferKindFromSingleNumber(num) {
  if ([98, 99, 100, 337, 338, 339].includes(num)) return "plant";
  if (
    (num >= 101 && num <= 112) ||
    [270, 271, 272, 273, 274, 306, 307, 315, 316, 329, 330, 331, 332, 333, 334, 335, 336].includes(num)
  ) {
    return "chair";
  }
  if (
    (num >= 147 && num <= 152) ||
    [156, 233, 323, 324, 325, 326, 327, 328].includes(num)
  ) {
    return "printer";
  }
  if ([169, 170, 171, 172].includes(num)) return "whiteboard";
  if (
    (num >= 96 && num <= 97) ||
    (num >= 113 && num <= 146) ||
    (num >= 153 && num <= 164) ||
    (num >= 225 && num <= 244) ||
    (num >= 275 && num <= 280) ||
    (num >= 308 && num <= 314) ||
    (num >= 317 && num <= 322)
  ) {
    return "cabinet";
  }
  if (
    (num >= 1 && num <= 85) ||
    (num >= 86 && num <= 95) ||
    (num >= 179 && num <= 187) ||
    (num >= 196 && num <= 209) ||
    (num >= 213 && num <= 218) ||
    (num >= 265 && num <= 269) ||
    (num >= 301 && num <= 305)
  ) {
    return "partition";
  }
  if (
    (num >= 165 && num <= 168) ||
    (num >= 173 && num <= 178) ||
    (num >= 320 && num <= 322)
  ) {
    return "pantry_counter";
  }
  if (
    (num >= 188 && num <= 195) ||
    (num >= 248 && num <= 264) ||
    (num >= 284 && num <= 300)
  ) {
    return "meeting_table";
  }
  if (
    (num >= 210 && num <= 212) ||
    (num >= 219 && num <= 224) ||
    (num >= 245 && num <= 247) ||
    (num >= 281 && num <= 283) ||
    (num >= 287 && num <= 288)
  ) {
    return "desk";
  }
  return "desk";
}

async function collectOfficeSingles() {
  if (!(await exists(officeSourceDir))) {
    console.log(
      `[limezu] NOTE: Office singles source not found (${officeSourceDir}); skipping "office" category.`
    );
    return [];
  }
  const entries = await readdir(officeSourceDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .sort((a, b) => singleNumber(a.name) - singleNumber(b.name))
    .map((entry) => {
      const num = singleNumber(entry.name);
      const relativeFile = path
        .relative(sourceDir, path.join(officeSourceDir, entry.name))
        .replace(/\\/g, "/");
      return {
        id: `office-${num}`,
        label: `辦公室 ${num}`,
        file: relativeFile,
        image: toPublicUrl(relativeFile),
        kind: inferKindFromSingleNumber(num),
        category: "office",
        categoryLabel: "辦公室",
        fit: "contain",
      };
    });
}

// --- Source B: Interiors theme-sorter singles --------------------------
//
// ADR-003 documented "26 個主題資料夾". The actual purchased package on
// disk (2026-07-12 scan) only has 24: folder numbers 2-16 and 18-26 exist;
// 1_ and 17_ do not (vendor numbering gap — "1" is used by the parent
// `1_Interiors` folder itself, "17" was never populated in this package
// version). This table only lists the 24 that are real; an unrecognized
// folder number is skipped with a NOTE instead of crashing, so a future
// package update that fills the gap (or adds a 27th) degrades gracefully
// instead of failing.
//
// `defaultKind` is the LayoutKind (footprint/collision type, see
// web/src/panels/LayoutEditorPanel.tsx `KINDS`) assigned to every item in
// that theme. Unlike Office there's no reliable per-item numeric heuristic
// across 24 unrelated vendor numbering schemes, so every item in a theme
// gets one reasonable default matching its most common furniture shape.
const THEME_CATEGORIES = [
  { num: 2, slug: "living_room", label: "客廳", defaultKind: "cabinet" },
  { num: 3, slug: "bathroom", label: "浴室", defaultKind: "pantry_counter" },
  { num: 4, slug: "bedroom", label: "臥室", defaultKind: "cabinet" },
  { num: 5, slug: "classroom_library", label: "教室圖書館", defaultKind: "desk" },
  { num: 6, slug: "music_sport", label: "音樂運動", defaultKind: "cabinet" },
  { num: 7, slug: "art", label: "藝術", defaultKind: "whiteboard" },
  { num: 8, slug: "gym", label: "健身房", defaultKind: "cabinet" },
  { num: 9, slug: "fishing", label: "釣魚", defaultKind: "plant" },
  { num: 10, slug: "birthday_party", label: "生日派對", defaultKind: "plant" },
  { num: 11, slug: "halloween", label: "萬聖節", defaultKind: "plant" },
  { num: 12, slug: "kitchen", label: "廚房", defaultKind: "cabinet" },
  { num: 13, slug: "conference_hall", label: "會議廳", defaultKind: "meeting_table" },
  { num: 14, slug: "basement", label: "地下室", defaultKind: "cabinet" },
  { num: 15, slug: "christmas", label: "聖誕", defaultKind: "plant" },
  { num: 16, slug: "grocery_store", label: "雜貨店", defaultKind: "pantry_counter" },
  { num: 18, slug: "jail", label: "監獄", defaultKind: "partition" },
  { num: 19, slug: "hospital", label: "醫院", defaultKind: "cabinet" },
  { num: 20, slug: "japanese_interiors", label: "日式", defaultKind: "cabinet" },
  { num: 21, slug: "clothing_store", label: "服飾店", defaultKind: "partition" },
  { num: 22, slug: "museum", label: "博物館", defaultKind: "cabinet" },
  { num: 23, slug: "tv_film_studio", label: "電視攝影棚", defaultKind: "desk" },
  { num: 24, slug: "ice_cream_shop", label: "冰淇淋店", defaultKind: "pantry_counter" },
  { num: 25, slug: "shooting_range", label: "射擊場", defaultKind: "partition" },
  { num: 26, slug: "condominium", label: "公寓", defaultKind: "cabinet" },
];

function parseThemeDirNumber(dirName) {
  const match = dirName.match(/^(\d+)_/);
  return match ? Number(match[1]) : null;
}

// Returns groups (one per theme category actually found on disk), each
// with its catalog items already built. Iteration is sorted by folder
// number for stable, deterministic output (ADR-003 D4).
async function collectThemeGroups() {
  if (!(await exists(themeSorterDir))) {
    console.log(
      `[limezu] NOTE: Interiors theme-sorter source not found (${themeSorterDir}); skipping theme categories.`
    );
    return [];
  }
  const entries = await readdir(themeSorterDir, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ entry, num: parseThemeDirNumber(entry.name) }))
    .sort((a, b) => {
      if (a.num !== null && b.num !== null) return a.num - b.num;
      if (a.num !== null) return -1;
      if (b.num !== null) return 1;
      return a.entry.name.localeCompare(b.entry.name);
    });

  const groups = [];
  for (const { entry, num } of dirs) {
    const config = THEME_CATEGORIES.find((c) => c.num === num);
    if (!config) {
      console.log(
        `[limezu] NOTE: unmapped theme folder "${entry.name}" (no entry in THEME_CATEGORIES) — skipped.`
      );
      continue;
    }
    const dirPath = path.join(themeSorterDir, entry.name);
    const files = (await readdir(dirPath, { withFileTypes: true }))
      .filter((f) => f.isFile() && f.name.toLowerCase().endsWith(".png"))
      .sort((a, b) => singleNumber(a.name) - singleNumber(b.name));
    const items = files.map((file) => {
      const num2 = singleNumber(file.name);
      const relativeFile = path
        .relative(sourceDir, path.join(dirPath, file.name))
        .replace(/\\/g, "/");
      return {
        id: `${config.slug}-${pad3(num2)}`,
        label: `${config.label} ${pad3(num2)}`,
        file: relativeFile,
        image: toPublicUrl(relativeFile),
        kind: config.defaultKind,
        category: config.slug,
        categoryLabel: config.label,
        fit: "contain",
      };
    });
    if (items.length === 0) continue;
    groups.push({ slug: config.slug, label: config.label, items });
    console.log(`[limezu]   ${config.slug} (${config.label}): ${items.length} file(s)`);
  }
  return groups;
}

// --- Sprites: 10 legacy LayoutKind representative images --------------
//
// Hand-picked Office single numbers, one per LayoutKind, so furniture
// placed by kind (no specific catalog item chosen) renders a real image
// instead of a color block. Each number's kind is verified against
// inferKindFromSingleNumber's ranges above (comment per pick).
const SPRITE_PICKS = {
  desk: 210, // inferKindFromSingleNumber(210) === "desk" (210-212 range)
  exec_desk: 245, // "desk" range (245-247) — bulkier single, used to visually distinguish exec_desk from plain desk
  chair: 101, // "chair" range (101-112)
  partition: 10, // "partition" range (1-85)
  meeting_table: 188, // "meeting_table" range (188-195)
  cabinet: 120, // "cabinet" range (113-146)
  printer: 147, // "printer" range (147-152)
  plant: 98, // "plant" set (98/99/100/337/338/339)
  pantry_counter: 165, // "pantry_counter" range (165-168)
  whiteboard: 169, // "whiteboard" range (169-172)
};

function buildSprites(officeCatalog) {
  const byNum = new Map();
  for (const item of officeCatalog) {
    byNum.set(Number(item.id.slice("office-".length)), item);
  }
  const sprites = {};
  for (const [kind, num] of Object.entries(SPRITE_PICKS)) {
    const item = byNum.get(num);
    if (!item) {
      console.log(
        `[limezu] NOTE: sprite pick for "${kind}" (office-${num}) not found in scanned Office catalog — omitted; editor falls back to a color block for this kind.`
      );
      continue;
    }
    sprites[kind] = { file: item.file, image: item.image, fit: "contain" };
  }
  return sprites;
}

// --- Copy + manifest ----------------------------------------------------

async function copyGroup(label, items) {
  if (items.length === 0) return;
  const targetDir = path.dirname(safeJoin(publicDir, items[0].file));
  await mkdir(targetDir, { recursive: true });
  await Promise.all(
    items.map(async (item) => {
      const sourceFile = safeJoin(sourceDir, item.file);
      const targetFile = safeJoin(publicDir, item.file);
      if (!(await exists(sourceFile))) {
        throw new Error(`Missing LimeZu file referenced by scan: ${sourceFile}`);
      }
      await copyFile(sourceFile, targetFile);
    })
  );
  console.log(`[limezu] copied ${items.length} file(s) for ${label}`);
}

async function main() {
  const officeCatalog = await collectOfficeSingles();
  const themeGroups = await collectThemeGroups();

  if (officeCatalog.length === 0 && themeGroups.length === 0) {
    logSkip(
      `No LimeZu source files found under ${sourceDir}.\n` +
        `  This is expected until you've bought/placed the LimeZu "Modern Office" and\n` +
        `  "Modern Interiors" packages — see assets/README.md ("LimeZu 購買與放置說明")\n` +
        `  for where to get them. Expected layout:\n` +
        `    ${officeSourceDir}/Modern_Office_Singles_32x32_<N>.png\n` +
        `    ${themeSorterDir}/<N>_<主題名>_Singles_32x32/..._<N>.png\n` +
        `  Until then, the layout editor's furniture palette falls back to plain color blocks.`
    );
    return;
  }

  const groups = [];
  if (officeCatalog.length > 0) {
    groups.push({ slug: "office", label: "辦公室", items: officeCatalog });
  }
  groups.push(...themeGroups);

  const catalog = groups.flatMap((group) => group.items);
  const categories = groups.map((group) => ({
    slug: group.slug,
    label: group.label,
    count: group.items.length,
  }));
  const sprites = buildSprites(officeCatalog);

  await mkdir(publicDir, { recursive: true });
  for (const group of groups) {
    await copyGroup(`${group.slug} (${group.label})`, group.items);
  }

  const publicManifest = {
    sprites,
    catalog,
    categories,
    generatedFrom:
      "assets/tilesets/limezu-modern-office/ (scanned: Office singles + Interiors theme-sorter singles)",
    generatedAt: new Date().toISOString(),
  };
  await writeFile(publicManifestPath, `${JSON.stringify(publicManifest, null, 2)}\n`);

  console.log(
    `[limezu] OK: catalog=${catalog.length} item(s), categories=${categories.length}, ` +
      `sprites=${Object.keys(sprites).length}/10 kind(s), wrote ${publicManifestPath}`
  );
}

main().catch((err) => {
  console.error(`[limezu] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
