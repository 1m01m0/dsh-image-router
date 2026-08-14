#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PLUGIN_ID = "image-router";
const PLUGIN_NAME = "dsh-image-router";
const LEGACY_NAMES = ["dsh-image-proxy"];
const LEGACY_IDS = ["image-proxy"];

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

function values(flag) {
  const output = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === flag) output.push(process.argv[i + 1]);
  }
  return output;
}

function defaultHome() {
  const desktop = join(homedir(), "Library", "Application Support", "DeepSeek Harness", "dsh");
  if (existsSync(join(desktop, "profiles", "web", "cordis.yml"))) return desktop;
  return join(homedir(), ".dsh");
}

function dshHome() {
  const explicit = value("--home") || process.env.DSH_HOME;
  return resolve(explicit && explicit.trim() ? explicit : defaultHome());
}

function positiveInteger(raw, fallback, flag) {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(flag + " must be a positive integer");
  }
  return parsed;
}

function stripBlocks(patch) {
  const names = new Set([PLUGIN_NAME, ...LEGACY_NAMES]);
  const ids = new Set([PLUGIN_ID, ...LEGACY_IDS]);
  const lines = patch.split("\n");
  const output = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^#\s*dsh-image-(router|proxy):/i.test(line.trimStart())) {
      i++;
      continue;
    }
    if (/^-\s*insert:/.test(line)) {
      const group = [line];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" || /^\s+/.test(lines[j]))) {
        group.push(lines[j]);
        j++;
      }
      const owned = group.some((entry) =>
        [...names].some((name) => entry.includes("name: " + name)) ||
        [...ids].some((id) => entry.includes("id: " + id))
      );
      if (!owned) output.push(...group);
      i = j;
      continue;
    }
    output.push(line);
    i++;
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const home = dshHome();
const profile = join(home, "profiles", "web");
const patchFile = join(profile, "cordis.patch.yml");
const installDir = join(profile, "node_modules", PLUGIN_NAME);
if (!existsSync(join(profile, "cordis.yml"))) {
  throw new Error("Web profile not found: " + profile + " (use --home to select DSH_HOME)");
}

const visionProvider = value("--vision-provider") || "minimax-cn";
const visionModel = value("--vision-model") || "MiniMax-M3";
const visionMaxTokens = positiveInteger(value("--vision-max-tokens"), 4096, "--vision-max-tokens");
const visionAttempts = positiveInteger(value("--vision-attempts"), 2, "--vision-attempts");
const sourceProviders = values("--source-provider");
if (sourceProviders.length === 0) sourceProviders.push("deepseek-official");

await rm(installDir, { recursive: true, force: true });
await mkdir(installDir, { recursive: true });
for (const filename of ["index.js", "package.json", "README.md", "LICENSE"]) {
  await cp(join(ROOT, filename), join(installDir, filename));
}
for (const legacy of LEGACY_NAMES) {
  await rm(join(profile, "node_modules", legacy), { recursive: true, force: true });
}

let patch = "";
try { patch = await readFile(patchFile, "utf8"); } catch {}
const cleaned = stripBlocks(patch);
const block = [
  "# dsh-image-router: configurable vision model sees images; DeepSeek produces the final answer.",
  "- insert:",
  "    - id: " + PLUGIN_ID,
  "      name: " + PLUGIN_NAME,
  "      config:",
  "        visionProvider: " + JSON.stringify(visionProvider),
  "        visionModel: " + JSON.stringify(visionModel),
  "        visionMaxTokens: " + visionMaxTokens,
  "        visionAttempts: " + visionAttempts,
  "        sourceProviders: " + JSON.stringify(sourceProviders),
].join("\n");
const next = cleaned === "[]" || cleaned === ""
  ? block + "\n"
  : cleaned + "\n\n" + block + "\n";
await writeFile(patchFile, next);

console.log("✓ Installed " + PLUGIN_NAME + " to " + installDir);
console.log("✓ Vision route: " + visionProvider + " / " + visionModel);
console.log("✓ Vision attempts: " + visionAttempts);
console.log("✓ Source providers: " + sourceProviders.join(", "));
console.log("Restart DeepSeek Harness to apply the change.");
