import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const origin = 'https://hub.example.com';

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { await run(); } finally { globalThis.fetch = original; }
}

test('token exchange preserves credentials and repository scope', async () => {
  await withFetch(async request => {
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://auth.docker.io');
    assert.equal(url.searchParams.get('scope'), 'repository:heizicao/frog-nas:pull');
    assert.equal(request.headers.get('authorization'), 'Basic dGVzdDp0ZXN0');
    return Response.json({ token: 'test-token' });
  }, async () => {
    const result = await worker.fetch(new Request(`${origin}/token?service=registry.docker.io&scope=repository%3Aheizicao%2Ffrog-nas%3Apull`, {
      headers: { authorization: 'Basic dGVzdDp0ZXN0', 'user-agent': 'Mozilla/5.0' },
    }));
    assert.equal((await result.json()).token, 'test-token');
  });
});

test('registry requests reach the upstream and preserve Bearer tokens', async () => {
  await withFetch(async request => {
    assert.equal(request.url, 'https://registry-1.docker.io/v2/heizicao/frog-nas/manifests/1.0.5');
    assert.equal(request.headers.get('authorization'), 'Bearer test-token');
    return new Response(null, { status: 200 });
  }, async () => {
    assert.equal((await worker.fetch(new Request(`${origin}/v2/heizicao/frog-nas/manifests/1.0.5`, {
      headers: { authorization: 'Bearer test-token', 'user-agent': 'Mozilla/5.0' },
    }))).status, 200);
  });
});

test('authentication challenge points back to the Worker', async () => {
  await withFetch(async () => new Response(null, {
    status: 401,
    headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' },
  }), async () => {
    const result = await worker.fetch(new Request(`${origin}/v2/`));
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('www-authenticate'), `Bearer realm="${origin}/token",service="registry.docker.io"`);
  });
});

test('routing stays isolated between requests and only normalizes Docker Hub paths', async () => {
  const urls = [];
  await withFetch(async request => {
    urls.push(request.url);
    return new Response(null);
  }, async () => {
    await worker.fetch(new Request('https://quay.example.com/v2/org/image/tags/list'));
    await worker.fetch(new Request(`${origin}/v2/nginx/manifests/latest`, { headers: { authorization: 'Bearer test-token' } }));
    await worker.fetch(new Request(`${origin}/v2/org/image/manifests/latest?ns=ghcr.io`));
    await worker.fetch(new Request(`${origin}/v2/`));
    assert.deepEqual(urls, [
      'https://quay.io/v2/org/image/tags/list',
      'https://registry-1.docker.io/v2/library/nginx/manifests/latest',
      'https://ghcr.io/v2/org/image/manifests/latest',
      'https://registry-1.docker.io/v2/',
    ]);
  });
});

test('blob redirects do not disclose registry credentials to another origin', async () => {
  let calls = 0;
  await withFetch(async (input, init) => {
    if (++calls === 1) {
      assert.equal(input.redirect, 'manual');
      return new Response(null, { status: 307, headers: { location: 'https://cdn.example.com/blob' } });
    }
    assert.equal(String(input), 'https://cdn.example.com/blob');
    assert.equal(init.headers.has('authorization'), false);
    assert.equal(init.headers.has('cookie'), false);
    return new Response('blob');
  }, async () => {
    const result = await worker.fetch(new Request(`${origin}/v2/org/image/blobs/sha256:123`, {
      headers: { authorization: 'Bearer test-token', cookie: 'session=test' },
    }));
    assert.equal(await result.text(), 'blob');
    assert.equal(calls, 2);
  });
});

test('preflight returns requested headers without fetching upstream', async () => {
  await withFetch(() => assert.fail('Unexpected upstream request'), async () => {
    const result = await worker.fetch(new Request(`${origin}/v2/`, {
      method: 'OPTIONS', headers: { 'access-control-request-headers': 'authorization' },
    }));
    assert.equal(result.status, 204);
    assert.equal(result.headers.get('access-control-allow-headers'), 'authorization');
  });
});


test('legacy search and browser search use the updated upstream hosts', async () => {
  const urls = [];
  await withFetch(async request => {
    urls.push(request.url);
    return new Response(null);
  }, async () => {
    await worker.fetch(new Request(`${origin}/v1/search?q=library/nginx`));
    await worker.fetch(new Request(`${origin}/v1/repositories/library/nginx/tags`));
    await worker.fetch(new Request(`${origin}/search?q=nginx`, { headers: { 'user-agent': 'Mozilla/5.0' } }));
    assert.deepEqual(urls, [
      'https://index.docker.io/v1/search?q=nginx',
      'https://index.docker.io/v1/repositories/library/nginx/tags',
      'https://hub.docker.com/search?q=nginx',
    ]);
  });
});

test('anonymous tag indexing obtains a repository-scoped token', async () => {
  let calls = 0;
  await withFetch(async input => {
    if (++calls === 1) {
      assert.equal(input.origin, 'https://auth.docker.io');
      assert.equal(input.searchParams.get('scope'), 'repository:library/nginx:pull');
      return Response.json({ token: 'anonymous-token' });
    }
    assert.equal(input.url, 'https://registry-1.docker.io/v2/library/nginx/tags/list');
    assert.equal(input.headers.get('authorization'), 'Bearer anonymous-token');
    return Response.json({ tags: ['latest'] });
  }, async () => {
    const result = await worker.fetch(new Request(`${origin}/v2/library/nginx/tags/list`));
    assert.deepEqual(await result.json(), { tags: ['latest'] });
    assert.equal(calls, 2);
  });
});

test('failed anonymous token lookup falls back to the registry challenge', async () => {
  let calls = 0;
  await withFetch(async input => {
    if (++calls === 1) return new Response(null, { status: 401 });
    assert.equal(input.headers.has('authorization'), false);
    return new Response(null, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token"' },
    });
  }, async () => {
    const result = await worker.fetch(new Request(`${origin}/v2/private/image/tags/list`));
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('www-authenticate'), `Bearer realm="${origin}/token"`);
    assert.equal(calls, 2);
  });
});
