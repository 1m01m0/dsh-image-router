#!/usr/bin/env node
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const NAMES = ["dsh-image-router", "dsh-image-proxy"];
const IDS = ["image-router", "image-proxy"];

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}
function defaultHome() {
  const desktop = join(homedir(), "Library", "Application Support", "DeepSeek Harness", "dsh");
  if (existsSync(join(desktop, "profiles", "web", "cordis.yml"))) return desktop;
  return join(homedir(), ".dsh");
}
const home = resolve(value("--home") || process.env.DSH_HOME || defaultHome());
const profile = join(home, "profiles", "web");
const patchFile = join(profile, "cordis.patch.yml");

if (existsSync(patchFile)) {
  const patch = await readFile(patchFile, "utf8");
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
        NAMES.some((name) => entry.includes("name: " + name)) ||
        IDS.some((id) => entry.includes("id: " + id))
      );
      if (!owned) output.push(...group);
      i = j;
      continue;
    }
    output.push(line);
    i++;
  }
  await writeFile(patchFile, output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
}

for (const name of NAMES) {
  await rm(join(profile, "node_modules", name), { recursive: true, force: true });
}
console.log("✓ Removed dsh-image-router. Restart DeepSeek Harness to apply the change.");
