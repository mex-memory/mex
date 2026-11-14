import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const title = 'Release performance on next needs attention';

// The final workflow job serializes this read/create pair for each branch.
// List directly so a just-created issue is visible before search indexing.
export function trackPerformanceFailure({ env = process.env, run = (args) => execFileSync('gh', args, { encoding: 'utf8' }), write = writeFileSync } = {}) {
  const issues = JSON.parse(run(['issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title']));
  const existing = issues.filter((issue) => issue.title === title).sort((a, b) => a.number - b.number)[0];
  if (!existing && issues.length >= 1000) throw new Error('Open issue limit reached; refusing to risk a duplicate tracking issue');
  const body = `Release performance failed on \`${env.GITHUB_SHA}\`.\n\nEvidence: ${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}\n`;
  const bodyFile = join(env.RUNNER_TEMP || tmpdir(), `performance-issue-${env.GITHUB_RUN_ID}.md`);
  write(bodyFile, body);
  return run(existing
    ? ['issue', 'comment', String(existing.number), '--body-file', bodyFile]
    : ['issue', 'create', '--title', title, '--body-file', bodyFile]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(trackPerformanceFailure().trim());
