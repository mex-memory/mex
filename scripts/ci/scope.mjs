import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only prose outside the shipped package and calibration inputs is exempt.
// Root Markdown is packaged; docs/design JSON is read by benchmark tests.
export function classify(paths, event = 'pull_request') {
  const docsOnly = event === 'pull_request' && paths.length > 0 && paths.every((path) =>
    /^docs\/(?:[^/]+\.md|design\/[^/]+\.md|diagrams\/.*\.svg)$/.test(path));
  return { docsOnly, workflows: event !== 'pull_request' || paths.some((path) => path.startsWith('.github/workflows/')) };
}

export function changedPaths(base, head, git = (args) => execFileSync('git', args, { encoding: 'utf8' })) {
  if (![base, head].every((sha) => /^[a-f0-9]{40,64}$/.test(sha))) throw new Error('Missing or invalid pull request revisions');
  const ancestor = git(['merge-base', base, head]).trim();
  // Include both sides of renames: moving a source into docs must run tests.
  return git(['diff', '--no-renames', '--name-only', '-z', ancestor, head]).split('\0').filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const paths = process.env.GITHUB_EVENT_NAME === 'pull_request'
    ? changedPaths(event.pull_request.base.sha, event.pull_request.head.sha) : [];
  const scope = classify(paths, process.env.GITHUB_EVENT_NAME);
  appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${scope.docsOnly}\nworkflows=${scope.workflows}\n`);
  console.log(JSON.stringify({ ...scope, changedFiles: paths.length }));
}
