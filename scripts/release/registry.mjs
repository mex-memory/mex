import { createServer } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { packedManifest } from './bundle.mjs';

// A read-only npm registry fixture: real packuments and original tarballs for
// this bundle, public npm metadata for other dependencies. npm itself applies
// os/cpu selection. No accounts, publishing protocol or registry dependency.
export async function localRegistry(directory, plan) {
  const packages = new Map();
  for (const entry of plan.packages) packages.set(entry.name, { entry, manifest: await packedManifest(join(directory, entry.file)) });
  let origin;
  const server = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method) || !request.url.startsWith('/') || request.url.startsWith('//')) { response.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1);
      for (const { entry } of packages.values()) {
        if (path === `${entry.name}/-/${entry.file}`) {
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          if (request.method === 'HEAD') response.end(); else createReadStream(join(directory, entry.file)).pipe(response);
          return;
        }
      }
      const item = packages.get(path) || packages.get(path.replace(`/${plan.version}`, ''));
      if (item) {
        const bytes = readFileSync(join(directory, item.entry.file));
        const manifest = { ...item.manifest, dist: { tarball: `${origin}/${item.entry.name}/-/${item.entry.file}`, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), shasum: createHash('sha1').update(bytes).digest('hex') } };
        const body = path === item.entry.name ? { name: item.entry.name, 'dist-tags': { latest: plan.version, next: plan.version }, versions: { [plan.version]: manifest } } : manifest;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)); return;
      }
      // Never forward local credentials or arbitrary redirect destinations.
      const upstream = await fetch('https://registry.npmjs.org' + request.url, { headers: { accept: 'application/vnd.npm.install-v1+json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      const text = await upstream.text();
      if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Registry metadata exceeds limit');
      response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(text);
    } catch { if (!response.headersSent) response.writeHead(502); response.end('Registry fixture could not serve dependency'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
