export const jobHash = (jobId: string) => "#job-" + encodeURIComponent(jobId);

export function jobIdFromHash(hash: string) {
  if (!hash.startsWith("#job-")) return;
  try {
    const id = decodeURIComponent(hash.slice(5));
    return /^[A-Za-z0-9._-]{1,128}$/u.test(id) ? id : undefined;
  } catch { return undefined; }
}
