// Hibernate 7 on Spring Boot 4 — project detection from Maven / Gradle files.

import type { ResolutionContext } from "../types.js";
import {
  candidateBuildFiles,
  isSpringBoot4Project,
} from "./spring-boot-detect.js";

const HIBERNATE_CORE =
  /org\.hibernate(?:\.orm)?\s*:\s*hibernate-core|hibernate-core|org\.hibernate\.orm/;

const HIBERNATE_VERSION_7 = /(?:^|[^0-9])7\.\d+(?:\.\d+)?(?:[-.][\w]+)?/;
const HIBERNATE_VERSION_OLD = /(?:^|[^0-9])[56]\.\d+(?:\.\d+)?(?:[-.][\w]+)?/;

const JPA_STARTER =
  /spring-boot-starter-data-jpa|spring-boot-data-jpa/;

const HIBERNATE_COORD_7 =
  /(?:org\.hibernate(?:\.orm)?\s*:\s*)?hibernate-core\s*:\s*7\.\d+/i;

/**
 * True when text shows Hibernate major 7, or Boot-managed JPA starter
 * without an explicit older Hibernate pin.
 */
export function hasHibernate7Evidence(text: string): boolean {
  if (!text) return false;

  // Explicit older hibernate-core pin wins as negative for this helper alone
  // when no 7.x is also present.
  const explicitOld = hasExplicitHibernateMajor(text, HIBERNATE_VERSION_OLD);
  const explicit7 = hasExplicitHibernateMajor(text, HIBERNATE_VERSION_7);

  if (explicitOld && !explicit7) return false;
  if (explicit7) return true;

  if (HIBERNATE_COORD_7.test(text.replace(/\s+/g, ""))) return true;

  // Boot-managed JPA without explicit version on hibernate
  if (JPA_STARTER.test(text)) return true;

  // hibernate-core dependency block: BOM-managed (no version) or 7.x
  if (HIBERNATE_CORE.test(text) && !explicitOld) {
    for (const block of text.split(/<\/dependency>/i)) {
      if (!/<artifactId>\s*hibernate-core\s*<\/artifactId>/i.test(block)) continue;
      const afterArtifact = block.split(/hibernate-core/i).slice(1).join("hibernate-core");
      const ver = afterArtifact.match(/<version>\s*([^<]+?)\s*<\/version>/i);
      if (!ver) return true; // BOM-managed
      const v = ver[1]!.trim();
      if (/^7\./.test(v)) return true;
      if (/^[56]\./.test(v)) return false;
    }
  }

  return false;
}

function hasExplicitHibernateMajor(text: string, versionRe: RegExp): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (!/hibernate/i.test(line) && !/org\.hibernate/.test(line)) continue;
    if (versionRe.test(line)) return true;
  }
  // Maven: only dependency blocks that themselves declare hibernate (not parent)
  for (const block of text.split(/<\/dependency>/i)) {
    if (!/<artifactId>\s*hibernate-core\s*<\/artifactId>/i.test(block) &&
        !/<groupId>\s*org\.hibernate(?:\.orm)?\s*<\/groupId>/i.test(block)) {
      continue;
    }
    // Prefer version after hibernate artifactId; else any version in this block
    const afterArtifact = block.split(/hibernate-core/i).slice(1).join("hibernate-core");
    const ver =
      afterArtifact.match(/<version>\s*([^<]+?)\s*<\/version>/i) ??
      block.match(/<version>\s*([^<]+?)\s*<\/version>/i);
    if (!ver) continue;
    const v = ver[1]!.trim();
    if (versionRe.test(` ${v}`)) return true;
  }
  return false;
}

/**
 * Spring Boot 4 project **and** Hibernate 7 / data-jpa evidence.
 * Explicit Hibernate 6.x/5.x → false.
 */
export function isHibernate7OnSpringBoot4(context: ResolutionContext): boolean {
  if (!isSpringBoot4Project(context)) return false;

  let sawPositive = false;
  let sawExplicitOld = false;

  for (const path of candidateBuildFiles(context)) {
    const text = context.readFile(path);
    if (!text) continue;
    if (hasExplicitHibernateMajor(text, HIBERNATE_VERSION_OLD) &&
        !hasExplicitHibernateMajor(text, HIBERNATE_VERSION_7)) {
      sawExplicitOld = true;
    }
    if (hasHibernate7Evidence(text)) sawPositive = true;
  }

  if (sawExplicitOld && !sawPositive) return false;
  // If any file has explicit old and another has 7, positive wins via hasHibernate7Evidence
  if (sawExplicitOld) {
    // Re-check: only reject when project overall is old-only
    let any7 = false;
    for (const path of candidateBuildFiles(context)) {
      const text = context.readFile(path);
      if (text && hasExplicitHibernateMajor(text, HIBERNATE_VERSION_7)) any7 = true;
      if (text && JPA_STARTER.test(text) && !hasExplicitHibernateMajor(text, HIBERNATE_VERSION_OLD)) {
        // starter alone with old pin elsewhere — prefer strict: if any file pins old without 7
      }
    }
    if (!any7) {
      // data-jpa + old hibernate pin → treat as old
      for (const path of candidateBuildFiles(context)) {
        const text = context.readFile(path);
        if (text && hasExplicitHibernateMajor(text, HIBERNATE_VERSION_OLD)) return false;
      }
    }
  }

  return sawPositive;
}
