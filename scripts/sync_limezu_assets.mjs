#!/usr/bin/env node

import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "assets", "tilesets", "limezu-modern-office");
const publicDir = path.join(repoRoot, "web", "public", "tilesets", "limezu-modern-office");
const sourceManifestPath = path.join(sourceDir, "manifest.json");
const publicManifestPath = path.join(publicDir, "manifest.json");
const singlesDir = path.join(
  sourceDir,
  "Modern_Office_Revamped_v1.2",
  "4_Modern_Office_singles",
  "32x32"
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
    throw new Error(`Refusing to read outside ${base}: ${relativePath}`);
  }
  return full;
}

function toPublicUrl(relativePath) {
  return `/tilesets/limezu-modern-office/${relativePath.replace(/\\/g, "/")}`;
}

function normalizeSprite(kind, sprite) {
  if (!sprite || typeof sprite !== "object") {
    throw new Error(`Sprite "${kind}" must be an object`);
  }
  if (typeof sprite.file !== "string") {
    throw new Error(`Sprite "${kind}" must include a relative "file"`);
  }
  const { x, y, w, h, ...fullSprite } = sprite;
  return {
    ...fullSprite,
    image: toPublicUrl(sprite.file),
  };
}

function singleNumber(fileName) {
  const match = fileName.match(/_(\d+)\.png$/i);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

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

async function collectSingleMaterials() {
  if (!(await exists(singlesDir))) return [];
  const entries = await readdir(singlesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .sort((a, b) => singleNumber(a.name) - singleNumber(b.name))
    .map((entry) => {
      const num = singleNumber(entry.name);
      const relativeFile = path
        .relative(sourceDir, path.join(singlesDir, entry.name))
        .replace(/\\/g, "/");
      return {
        id: Number.isFinite(num) ? `single-${num}` : entry.name,
        label: Number.isFinite(num) ? `素材 ${num}` : entry.name,
        file: relativeFile,
        image: toPublicUrl(relativeFile),
        kind: inferKindFromSingleNumber(num),
        fit: "contain",
      };
    });
}

async function main() {
  if (!(await exists(sourceDir))) {
    logSkip(
      `LimeZu source directory not found: ${sourceDir}\n` +
        `  This is expected until you've bought/placed the LimeZu "Modern Office" package —\n` +
        `  see assets/README.md ("LimeZu 購買與放置說明") for where to get it. Next steps:\n` +
        `    1. mkdir -p "${sourceDir}"\n` +
        `    2. extract your downloaded LimeZu package into that folder\n` +
        `    3. cp "${path.join(sourceDir, "manifest.example.json")}" "${sourceManifestPath}"\n` +
        `       and edit the sprite \`file\` paths to match your extracted filenames\n` +
        `    4. re-run: node scripts/sync_limezu_assets.mjs\n` +
        `  Until then, the layout editor's furniture palette falls back to plain color blocks.`
    );
    return;
  }
  if (!(await exists(sourceManifestPath))) {
    logSkip(
      `manifest.json not found at ${sourceManifestPath}.\n` +
        `  Next step: cp "${path.join(
          sourceDir,
          "manifest.example.json"
        )}" "${sourceManifestPath}" and edit the sprite \`file\` paths to match your\n` +
        `  extracted LimeZu filenames (see the _comment/_schema_comment fields in that\n` +
        `  template for the expected shape), then re-run: node scripts/sync_limezu_assets.mjs`
    );
    return;
  }

  const manifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  const sprites = manifest.sprites ?? {};
  const publicSprites = {};
  const filesToCopy = new Set();
  const catalog = await collectSingleMaterials();

  for (const [kind, sprite] of Object.entries(sprites)) {
    const normalized = normalizeSprite(kind, sprite);
    publicSprites[kind] = normalized;
    filesToCopy.add(sprite.file);
  }
  for (const material of catalog) {
    filesToCopy.add(material.file);
  }

  await mkdir(publicDir, { recursive: true });
  for (const relativeFile of filesToCopy) {
    const sourceFile = safeJoin(sourceDir, relativeFile);
    const targetFile = safeJoin(publicDir, relativeFile);
    if (!(await exists(sourceFile))) {
      throw new Error(`Missing LimeZu file referenced by manifest: ${sourceFile}`);
    }
    await mkdir(path.dirname(targetFile), { recursive: true });
    await copyFile(sourceFile, targetFile);
  }

  const publicManifest = {
    ...manifest,
    sprites: publicSprites,
    catalog,
    generatedFrom: "assets/tilesets/limezu-modern-office/manifest.json",
    generatedAt: new Date().toISOString(),
  };
  await writeFile(publicManifestPath, `${JSON.stringify(publicManifest, null, 2)}\n`);
  console.log(
    `[limezu] OK: copied ${filesToCopy.size} file(s), cataloged ${catalog.length} material(s), and wrote ${publicManifestPath}`
  );
}

main().catch((err) => {
  console.error(`[limezu] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
