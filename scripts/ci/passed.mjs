import { pathToFileURL } from 'node:url';

export function assertPassed(needs) {
  if (needs.changes?.result !== 'success') throw new Error('Change detection did not pass');
  const docsOnly = needs.changes.outputs.docs_only === 'true';
  for (const [job, value] of Object.entries(needs)) {
    if (value.result === 'success') continue;
    if (docsOnly && ['check', 'package', 'go', 'storage-portability', 'hub-browser'].includes(job) && value.result === 'skipped') continue;
    throw new Error(`${job}: ${value.result}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertPassed(JSON.parse(process.env.CI_NEEDS));
  console.log('All required CI jobs passed (or were explicitly exempted for docs only).');
}
