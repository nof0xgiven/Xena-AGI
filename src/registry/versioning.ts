export type ParsedSemanticVersion = {
  raw: string;
  normalized: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: ReadonlyArray<number | string>;
  build: string | null;
};

const SEMANTIC_LIKE_VERSION =
  /^v?(?<major>0|[1-9]\d*)(?:\.(?<minor>0|[1-9]\d*))?(?:\.(?<patch>0|[1-9]\d*))?(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+(?<build>[0-9A-Za-z.-]+))?$/;

function parsePrereleaseSegment(segment: string): number | string {
  return /^\d+$/.test(segment) ? Number(segment) : segment.toLowerCase();
}

function comparePrimitive(left: number | string, right: number | string): number {
  if (typeof left === "number" && typeof right === "number") {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  if (typeof left === "number" && typeof right === "string") return -1;
  if (typeof left === "string" && typeof right === "number") return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function parseSemanticVersion(version: string): ParsedSemanticVersion | null {
  const match = version.trim().match(SEMANTIC_LIKE_VERSION);
  if (!match?.groups) return null;

  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor ?? "0");
  const patch = Number(match.groups.patch ?? "0");
  const prereleaseRaw = match.groups.prerelease ?? "";
  const prerelease = prereleaseRaw.length
    ? prereleaseRaw.split(".").filter((segment) => segment.length > 0).map(parsePrereleaseSegment)
    : [];
  const build = match.groups.build ?? null;
  const prereleaseText = prereleaseRaw.length ? `-${prereleaseRaw}` : "";

  return {
    raw: version,
    normalized: `${major}.${minor}.${patch}${prereleaseText}`,
    major,
    minor,
    patch,
    prerelease,
    build,
  };
}

function comparePrerelease(
  left: ReadonlyArray<number | string>,
  right: ReadonlyArray<number | string>,
): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftSegment = left[index];
    const rightSegment = right[index];
    if (leftSegment === undefined) return -1;
    if (rightSegment === undefined) return 1;
    const compared = comparePrimitive(leftSegment, rightSegment);
    if (compared !== 0) return compared;
  }
  return 0;
}

function lexicalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareSemanticVersions(leftVersion: string, rightVersion: string): number {
  const left = parseSemanticVersion(leftVersion);
  const right = parseSemanticVersion(rightVersion);

  if (!left && !right) return lexicalCompare(leftVersion, rightVersion);
  if (!left && right) return -1;
  if (left && !right) return 1;
  if (!left || !right) return 0;

  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;

  const prereleaseComparison = comparePrerelease(left.prerelease, right.prerelease);
  if (prereleaseComparison !== 0) return prereleaseComparison;

  const buildComparison = lexicalCompare(left.build ?? "", right.build ?? "");
  if (buildComparison !== 0) return buildComparison;

  return lexicalCompare(left.raw, right.raw);
}

export function selectHighestVersion<T extends { version: string }>(
  entries: readonly T[],
  tieBreaker?: (left: T, right: T) => number,
): T | null {
  if (entries.length === 0) return null;

  let highest = entries[0];
  for (let index = 1; index < entries.length; index += 1) {
    const candidate = entries[index];
    const versionComparison = compareSemanticVersions(candidate.version, highest.version);
    if (versionComparison > 0) {
      highest = candidate;
      continue;
    }
    if (versionComparison === 0 && tieBreaker && tieBreaker(candidate, highest) > 0) {
      highest = candidate;
    }
  }

  return highest;
}

