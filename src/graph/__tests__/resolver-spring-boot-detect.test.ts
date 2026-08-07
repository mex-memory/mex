import { describe, expect, it } from "vitest";
import {
  candidateBuildFiles,
  hasSpringBootMajor4,
  isSpringBoot4Project,
} from "../resolution/frameworks/spring-boot-detect.js";
import type { ResolutionContext } from "../resolution/types.js";

describe("hasSpringBootMajor4", () => {
  it("accepts Maven parent 4.0.0", () => {
    expect(
      hasSpringBootMajor4(`
      <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.0.0</version>
      </parent>`),
    ).toBe(true);
  });

  it("rejects Maven parent 3.5.0", () => {
    expect(
      hasSpringBootMajor4(`
      <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.5.0</version>
      </parent>`),
    ).toBe(false);
  });

  it("accepts Gradle Kotlin plugin 4.x", () => {
    expect(
      hasSpringBootMajor4(
        `plugins { id("org.springframework.boot") version "4.0.0" }`,
      ),
    ).toBe(true);
  });

  it("accepts Gradle Groovy plugin 4.x", () => {
    expect(
      hasSpringBootMajor4(
        `plugins { id "org.springframework.boot" version "4.1.2" }`,
      ),
    ).toBe(true);
  });

  it("accepts spring-boot-starter-webmvc when BOM 4 present", () => {
    expect(
      hasSpringBootMajor4(`
      <dependencyManagement>
        <dependency>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-dependencies</artifactId>
          <version>4.0.0</version>
          <type>pom</type>
          <scope>import</scope>
        </dependency>
      </dependencyManagement>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-webmvc</artifactId>
      </dependency>`),
    ).toBe(true);
  });

  it("accepts Gradle coordinate with Boot 4 version", () => {
    expect(
      hasSpringBootMajor4(
        `implementation("org.springframework.boot:spring-boot-starter-webmvc:4.0.0")`,
      ),
    ).toBe(true);
  });

  it("rejects unrelated 4.x version strings", () => {
    expect(hasSpringBootMajor4(`<version>4.0.0</version>`)).toBe(false);
  });

  it("rejects Spring Framework alone", () => {
    expect(
      hasSpringBootMajor4(
        `implementation("org.springframework:spring-web:6.2.0")`,
      ),
    ).toBe(false);
  });
});

describe("isSpringBoot4Project", () => {
  it("returns true when pom.xml has Boot 4 parent", () => {
    const ctx = fakeContext({
      "pom.xml": `
        <parent>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-starter-parent</artifactId>
          <version>4.0.0</version>
        </parent>`,
    });
    expect(isSpringBoot4Project(ctx)).toBe(true);
    expect(candidateBuildFiles(ctx)).toContain("pom.xml");
  });

  it("returns false when only Boot 3 present", () => {
    const ctx = fakeContext({
      "pom.xml": `
        <parent>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-starter-parent</artifactId>
          <version>3.5.0</version>
        </parent>`,
    });
    expect(isSpringBoot4Project(ctx)).toBe(false);
  });

  it("scans nested module build files", () => {
    const ctx = fakeContext({
      "services/api/build.gradle.kts":
        `plugins { id("org.springframework.boot") version "4.0.0" }`,
    });
    expect(isSpringBoot4Project(ctx)).toBe(true);
  });
});

function fakeContext(files: Record<string, string>): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    getNodeById: () => null,
    fileExists: (path) => path in files,
    readFile: (path) => files[path] ?? null,
    getProjectRoot: () => "/repo",
    getAllFiles: () => Object.keys(files),
  };
}
