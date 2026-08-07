import { describe, expect, it } from "vitest";
import {
  hasHibernate7Evidence,
  isHibernate7OnSpringBoot4,
} from "../resolution/frameworks/hibernate-detect.js";
import type { ResolutionContext } from "../resolution/types.js";

const BOOT4_PARENT = `
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>4.0.0</version>
  </parent>`;

const BOOT3_PARENT = `
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.5.0</version>
  </parent>`;

const DATA_JPA = `
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-jpa</artifactId>
  </dependency>`;

describe("hasHibernate7Evidence", () => {
  it("accepts explicit hibernate-core 7.x coordinate", () => {
    expect(
      hasHibernate7Evidence(
        `implementation("org.hibernate.orm:hibernate-core:7.0.10.Final")`,
      ),
    ).toBe(true);
  });

  it("accepts spring-boot-starter-data-jpa", () => {
    expect(hasHibernate7Evidence(DATA_JPA)).toBe(true);
  });

  it("rejects explicit hibernate-core 6.x", () => {
    expect(
      hasHibernate7Evidence(`
        <dependency>
          <groupId>org.hibernate.orm</groupId>
          <artifactId>hibernate-core</artifactId>
          <version>6.6.0.Final</version>
        </dependency>`),
    ).toBe(false);
  });
});

describe("isHibernate7OnSpringBoot4", () => {
  it("accepts Boot 4 pom with starter-data-jpa", () => {
    const ctx = fakeContext({
      "pom.xml": `${BOOT4_PARENT}${DATA_JPA}`,
    });
    expect(isHibernate7OnSpringBoot4(ctx)).toBe(true);
  });

  it("rejects Boot 3 pom with starter-data-jpa", () => {
    const ctx = fakeContext({
      "pom.xml": `${BOOT3_PARENT}${DATA_JPA}`,
    });
    expect(isHibernate7OnSpringBoot4(ctx)).toBe(false);
  });

  it("rejects Boot 4 with explicit hibernate-core 6.x", () => {
    const ctx = fakeContext({
      "pom.xml": `${BOOT4_PARENT}
        <dependency>
          <groupId>org.hibernate.orm</groupId>
          <artifactId>hibernate-core</artifactId>
          <version>6.6.0.Final</version>
        </dependency>`,
    });
    expect(isHibernate7OnSpringBoot4(ctx)).toBe(false);
  });

  it("accepts Boot 4 with explicit hibernate-core 7.x", () => {
    const ctx = fakeContext({
      "pom.xml": `${BOOT4_PARENT}
        <dependency>
          <groupId>org.hibernate.orm</groupId>
          <artifactId>hibernate-core</artifactId>
          <version>7.0.10.Final</version>
        </dependency>`,
    });
    expect(isHibernate7OnSpringBoot4(ctx)).toBe(true);
  });

  it("rejects Boot 4 without JPA/Hibernate marker", () => {
    const ctx = fakeContext({
      "pom.xml": `${BOOT4_PARENT}
        <dependency>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-starter-webmvc</artifactId>
        </dependency>`,
    });
    expect(isHibernate7OnSpringBoot4(ctx)).toBe(false);
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
