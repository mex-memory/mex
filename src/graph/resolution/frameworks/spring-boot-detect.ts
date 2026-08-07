// Spring Boot 4 project detection from Maven / Gradle build files.
// Pure string heuristics — no XML/Gradle AST dependency.

import type { ResolutionContext } from "../types.js";

const BUILD_BASENAMES = new Set([
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "libs.versions.toml",
]);

/** Boot major 4 version token (4.0, 4.0.0, 4.1.2-SNAPSHOT, …). */
const BOOT_MAJOR_4 = /(?:^|[^0-9])4\.\d+(?:\.\d+)?(?:[-.][\w]+)?/;

/** Boot major 3 (or other non-4) when paired with Boot markers. */
const BOOT_MAJOR_OTHER = /(?:^|[^0-9])[1235-9]\.\d+(?:\.\d+)?(?:[-.][\w]+)?/;

const BOOT_MARKER =
  /org\.springframework\.boot|spring-boot(?:-[\w.-]+)?/;

const BOOT_PARENT_OR_BOM =
  /spring-boot-starter-parent|spring-boot-dependencies/;

const BOOT_PLUGIN =
  /id\s*\(\s*["']org\.springframework\.boot["']\s*\)|id\s+["']org\.springframework\.boot["']/;

const BOOT_COORDINATE =
  /org\.springframework\.boot\s*:\s*spring-boot[\w.-]*\s*:\s*4\.\d+/;

/**
 * True when text evidence shows Spring Boot **major version 4**.
 * Boot 3-only or non-Boot `4.x` strings → false.
 */
export function hasSpringBootMajor4(text: string): boolean {
  if (!text || !BOOT_MARKER.test(text)) return false;

  // Strong: Gradle coordinate with embedded 4.x
  if (BOOT_COORDINATE.test(text.replace(/\s+/g, ""))) return true;

  // Strong: plugin line with version 4.x
  for (const line of text.split(/\r?\n/)) {
    if (BOOT_PLUGIN.test(line) && BOOT_MAJOR_4.test(line)) return true;
    if (
      /org\.springframework\.boot/.test(line) &&
      /spring-boot/.test(line) &&
      BOOT_MAJOR_4.test(line)
    ) {
      return true;
    }
  }

  // Maven parent / BOM / dependency blocks: window around boot artifact
  if (hasBoot4InXmlWindows(text)) return true;

  // libs.versions.toml: spring-boot version = "4.x"
  if (hasBoot4InToml(text)) return true;

  // File mentions Boot and some line pairs marker + 4.x (Gradle props etc.)
  let sawBoot4 = false;
  let sawBootOther = false;
  for (const line of text.split(/\r?\n/)) {
    if (!BOOT_MARKER.test(line)) continue;
    if (BOOT_MAJOR_4.test(line)) sawBoot4 = true;
    if (BOOT_MAJOR_OTHER.test(line) && !BOOT_MAJOR_4.test(line)) {
      sawBootOther = true;
    }
  }
  if (sawBoot4) return true;
  if (sawBootOther) return false;

  // BOM/parent present with version 4 somewhere in a tight multi-line block
  return false;
}

function hasBoot4InXmlWindows(text: string): boolean {
  // Collapse whitespace for simple tag searches
  const blocks = text.split(/<\/(?:parent|dependency)>/i);
  for (const block of blocks) {
    if (!BOOT_MARKER.test(block) && !BOOT_PARENT_OR_BOM.test(block)) continue;
    const versionMatch = block.match(
      /<version>\s*([^<]+?)\s*<\/version>/i,
    );
    if (!versionMatch) continue;
    const ver = versionMatch[1]!.trim();
    if (/^4\.\d+/.test(ver) && (BOOT_PARENT_OR_BOM.test(block) || /org\.springframework\.boot/.test(block))) {
      return true;
    }
  }
  return false;
}

function hasBoot4InToml(text: string): boolean {
  // spring-boot = "4.0.0" or springBoot = "4.0.0"
  if (
    /spring-?boot\s*=\s*["']4\.\d+/i.test(text) ||
    /springBoot\s*=\s*["']4\.\d+/.test(text)
  ) {
    return true;
  }
  // [versions] spring-boot = "4.x"
  for (const line of text.split(/\r?\n/)) {
    if (/spring/i.test(line) && /boot/i.test(line) && BOOT_MAJOR_4.test(line)) {
      return true;
    }
  }
  return false;
}

const MAX_BUILD_FILES = 50;

/** Project-relative build file paths worth scanning for Boot evidence. */
export function candidateBuildFiles(context: ResolutionContext): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (path: string): void => {
    const normalized = path.replace(/\\/g, "/");
    if (seen.has(normalized)) return;
    const base = normalized.includes("/")
      ? normalized.slice(normalized.lastIndexOf("/") + 1)
      : normalized;
    if (!BUILD_BASENAMES.has(base)) return;
    seen.add(normalized);
    found.push(normalized);
  };

  for (const root of [
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "gradle/libs.versions.toml",
  ]) {
    if (context.fileExists(root) || context.readFile(root) !== null) {
      push(root);
    }
  }

  for (const path of context.getAllFiles()) {
    if (found.length >= MAX_BUILD_FILES) break;
    push(path);
  }

  return found.slice(0, MAX_BUILD_FILES);
}

/** True when any candidate build file evidences Spring Boot 4.x. */
export function isSpringBoot4Project(context: ResolutionContext): boolean {
  for (const path of candidateBuildFiles(context)) {
    const text = context.readFile(path);
    if (text && hasSpringBootMajor4(text)) return true;
  }
  return false;
}
