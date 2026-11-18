import { gitDiscoveryCeilingReached } from "../../repository-discovery.js";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MexPortError } from "../contracts/shared.js";

const MAX_REPOSITORY_ANCESTORS = 128;

/**
 * Locate only the repository boundary needed to compose the Team CLI service.
 *
 * This deliberately does not open `.mex/config.json`. The repository-bound
 * workflow factory performs the bounded, no-follow, tracked-config attestation
 * after the root has been found.
 */
export function locateTeamRepositoryRoot(startDir = process.cwd()): string {
  if (
    typeof startDir !== "string"
    || startDir.length === 0
    || startDir.includes("\0")
  ) {
    throw invalidRepositoryLocation();
  }

  let current = resolve(startDir);
  if (current.split(/[\\/]/u).includes(".mex")) {
    throw unsafeRepositoryLocation();
  }

  for (let inspected = 0; inspected < MAX_REPOSITORY_ANCESTORS; inspected += 1) {
    try {
      const marker = lstatSync(resolve(current, ".git"));
      if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
        throw unsafeRepositoryLocation();
      }
      return current;
    } catch (error) {
      if (error instanceof MexPortError) throw error;
      if (errorCode(error) !== "ENOENT") throw unsafeRepositoryLocation();
    }

    const parent = dirname(current);
    if (parent === current || gitDiscoveryCeilingReached(parent)) break;
    current = parent;
  }

  throw repositoryNotFound();
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function invalidRepositoryLocation(): MexPortError {
  return new MexPortError({
    title: "Invalid Team repository location",
    status: 400,
    code: "INVALID_REQUEST",
    detail: "Run the Team command from a readable repository directory.",
  });
}

function unsafeRepositoryLocation(): MexPortError {
  return new MexPortError({
    title: "Unsafe Team repository boundary",
    status: 400,
    code: "PATH_OUTSIDE_PROJECT",
    detail: "The repository boundary could not be inspected without following an unsafe path.",
  });
}

function repositoryNotFound(): MexPortError {
  return new MexPortError({
    title: "Team repository unavailable",
    status: 404,
    code: "NOT_FOUND",
    detail: "Run the Team command from an initialized repository, then inspect mex capabilities --json.",
  });
}
