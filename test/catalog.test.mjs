import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogFromTree, createCatalogStore, exportCatalog, githubHttpApi, imageType, SOURCE_REPO, syncCatalog, validateCatalog } from '../catalog.mjs';
import { catalog, emoji, imageBytes } from './fixtures.mjs';

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bufo-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function treeEntry(index, name = `bufo-example-${index}`) {
  const entry = emoji(index, name);
  return { type: 'blob', mode: '100644', path: entry.filename, sha: entry.sha, size: entry.size };
}

test('public exports contain only the catalog and verified image files', async t => {
  const outputDir = await temporary(t);
  const value = catalog(3);
  const progress = [];
  await exportCatalog({
    outputDir, intervalMs: 0, onProgress: count => progress.push(count),
    store: {
      get: async () => value,
      image: async id => ({ bytes: imageBytes(Number.parseInt(id, 16)) })
    }
  });
  assert.deepEqual((await readdir(outputDir)).sort(), ['catalog.json', 'images']);
  assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'catalog.json'), 'utf8')), value);
  assert.equal((await readdir(join(outputDir, 'images'))).length, 3);
  assert.deepEqual(progress, [1, 2, 3]);
  let calls = 0;
  const store = createCatalogStore({ dataDir: outputDir, readOnly: true, api: async () => { calls += 1; } });
  assert.deepEqual((await store.image(value.emojis[0].id)).bytes, imageBytes(0));
  assert.equal(calls, 0);
});

test('export replaces a legacy snapshot and removes images outside the new catalog', async t => {
  const outputDir = await temporary(t);
  const old = { ...catalog(2), source: 'github/slack-emoji' };
  await mkdir(join(outputDir, 'images'));
  await writeFile(join(outputDir, 'catalog.json'), JSON.stringify(old));
  for (const entry of old.emojis) {
    await writeFile(join(outputDir, 'images', `${entry.sha}.${entry.extension}`), imageBytes(Number.parseInt(entry.id, 16)));
  }
  const value = { ...catalog(1), emojis: [emoji(9, 'bufo-public')] };
  await exportCatalog({
    outputDir, intervalMs: 0,
    store: { get: async () => value, image: async () => ({ bytes: imageBytes(9) }) }
  });
  assert.deepEqual(await readdir(join(outputDir, 'images')), [`${value.emojis[0].sha}.png`]);
  assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'catalog.json'), 'utf8')), value);
  const store = createCatalogStore({ dataDir: outputDir, readOnly: true });
  assert.deepEqual((await store.image(value.emojis[0].id)).bytes, imageBytes(9));
  await assert.rejects(store.image(old.emojis[0].id), { code: 'NOT_FOUND' });
});

test('export refuses legacy catalogs before reading or publishing any images', async t => {
  const outputDir = await temporary(t);
  await assert.rejects(exportCatalog({
    outputDir, intervalMs: 0,
    store: {
      get: async () => ({ ...catalog(1), source: 'github/slack-emoji' }),
      image: async () => assert.fail('Legacy images must never be exported')
    }
  }), { code: 'INVALID_CATALOG' });
  assert.deepEqual(await readdir(outputDir), []);
});

test('export fails explicitly on unexpected files instead of deleting unrelated data', async t => {
  const outputDir = await temporary(t);
  await mkdir(join(outputDir, 'images'));
  await writeFile(join(outputDir, 'images', 'notes.txt'), 'keep this file');
  await assert.rejects(exportCatalog({
    outputDir, intervalMs: 0,
    store: { get: async () => catalog(1), image: async () => ({ bytes: imageBytes(0) }) }
  }), { code: 'INVALID_IMAGE' });
  assert.equal(await readFile(join(outputDir, 'images', 'notes.txt'), 'utf8'), 'keep this file');
  await assert.rejects(readFile(join(outputDir, 'catalog.json')), { code: 'ENOENT' });
});

test('failed export does not publish a new catalog and read-only images never download or self-repair', async t => {
  const outputDir = await temporary(t);
  const value = catalog(1);
  await assert.rejects(exportCatalog({
    outputDir, intervalMs: 0,
    store: { get: async () => value, image: async () => ({ bytes: Buffer.from('invalid') }) }
  }), { code: 'INVALID_IMAGE' });
  await assert.rejects(readFile(join(outputDir, 'catalog.json')), { code: 'ENOENT' });
  await writeFile(join(outputDir, 'catalog.json'), JSON.stringify(value));
  let calls = 0;
  const store = createCatalogStore({ dataDir: outputDir, readOnly: true, api: async () => { calls += 1; } });
  await assert.rejects(store.image(value.emojis[0].id), { code: 'IMAGE_MISSING' });
  const path = join(outputDir, 'images', `${value.emojis[0].sha}.${value.emojis[0].extension}`);
  await mkdir(join(outputDir, 'images'));
  await writeFile(path, 'damaged');
  await assert.rejects(store.image(value.emojis[0].id), { code: 'INVALID_IMAGE' });
  assert.equal(await readFile(path, 'utf8'), 'damaged');
  assert.equal(calls, 0);
});

test('sync imports only the pinned public directory, including multipart images and GIF variants', async t => {
  const dataDir = await temporary(t);
  const calls = [];
  const bufoTree = 'b'.repeat(40);
  const result = await syncCatalog({
    dataDir,
    api: async (path, raw) => {
      calls.push({ path, raw });
      if (path === 'repos/knobiknows/all-the-bufo/git/trees/main') return {
        truncated: false,
        tree: [
          { type: 'tree', path: 'all-the-bufo', sha: bufoTree },
          { type: 'tree', path: 'other-images', sha: 'c'.repeat(40) },
          treeEntry(99, 'outside-the-collection')
        ]
      };
      if (path === `repos/knobiknows/all-the-bufo/git/trees/${bufoTree}?recursive=1`) return {
        truncated: false,
        tree: [
          treeEntry(1, 'bufo-party'), { ...treeEntry(2, 'bufo-party'), path: 'bufo-party.gif' },
          treeEntry(3, 'bufo-coffee'), treeEntry(4, 'bigbufo_0_0'), treeEntry(5, 'bigbufo_1_0')
        ]
      };
      assert.fail(`Unexpected path ${path}`);
    }
  });
  assert.equal(result.source, 'knobiknows/all-the-bufo');
  assert.deepEqual(result.emojis.map(entry => entry.name), ['bigbufo_0_0', 'bigbufo_1_0', 'bufo-coffee', 'bufo-party']);
  assert.equal(result.emojis.find(entry => entry.name === 'bufo-party').filename, 'bufo-party.gif');
  assert.equal(calls.length, 2);
  assert.equal(calls.filter(call => call.raw).length, 0);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'catalog.json'), 'utf8')), result);
  assert.equal((await stat(join(dataDir, 'catalog.json'))).mode & 0o077, 0);
});

test('public image IDs are stable and cannot reuse legacy source URLs', () => {
  const tree = [treeEntry(0), treeEntry(1)];
  const first = catalogFromTree({ truncated: false, tree }).emojis;
  const reordered = catalogFromTree({ truncated: false, tree: [...tree].reverse() }).emojis;
  assert.deepEqual(first, reordered);
  assert.equal(new Set(first.map(entry => entry.id)).size, 2);
  for (const entry of first) {
    const legacyId = createHash('sha256').update(entry.filename).digest('hex').slice(0, 20);
    assert.notEqual(entry.id, legacyId);
  }
});

test('missing, incomplete, or ambiguous public trees never overwrite the local catalog', async t => {
  const dataDir = await temporary(t);
  const before = JSON.stringify(catalog(1));
  await writeFile(join(dataDir, 'catalog.json'), before);
  const bufoTree = 'b'.repeat(40);
  const root = { truncated: false, tree: [{ type: 'tree', path: 'all-the-bufo', sha: bufoTree }] };
  const images = { truncated: false, tree: [treeEntry(0)] };
  for (const [rootResponse, imageResponse] of [
    [{ ...root, truncated: true }, images],
    [{ truncated: false, tree: [] }, images],
    [{ truncated: false, tree: [{ ...root.tree[0], sha: 'invalid' }] }, images],
    [root, { ...images, truncated: true }],
    [root, { truncated: false, tree: [] }],
    [root, { truncated: false, tree: [treeEntry(0), treeEntry(0)] }]
  ]) {
    await assert.rejects(syncCatalog({
      dataDir,
      api: async endpoint => {
        if (endpoint === `repos/${SOURCE_REPO}/git/trees/main`) return rootResponse;
        if (endpoint === `repos/${SOURCE_REPO}/git/trees/${bufoTree}?recursive=1`) return imageResponse;
        assert.fail(`Unexpected source request ${endpoint}`);
      }
    }), { code: 'INVALID_CATALOG' });
    assert.equal(await readFile(join(dataDir, 'catalog.json'), 'utf8'), before);
  }
});

test('rejects truncated trees, ambiguous duplicate names, and empty catalogs', () => {
  assert.throws(() => catalogFromTree({ truncated: true, tree: [treeEntry(0)] }), { code: 'INVALID_CATALOG' });
  assert.throws(() => catalogFromTree({ truncated: false, tree: [] }), { code: 'INVALID_CATALOG' });
  for (const tree of [
    [treeEntry(0), treeEntry(0)],
    [treeEntry(0), { ...treeEntry(1), path: 'bufo-example-0.jpg' }],
    [treeEntry(0), { ...treeEntry(1), path: 'nested/bufo-example-0.gif' }],
    [treeEntry(0), { ...treeEntry(1), path: 'bufo-example-0.gif' }, treeEntry(0)]
  ]) {
    assert.throws(() => catalogFromTree({ truncated: false, tree }), { code: 'INVALID_CATALOG' });
  }
});

test('GIF takes precedence over a same-name PNG regardless of tree order', () => {
  const png = treeEntry(0, 'bufo-football');
  const gif = { ...treeEntry(1, 'bufo-football'), path: 'bufo-football.gif' };
  for (const tree of [[png, gif], [gif, png]]) {
    const result = catalogFromTree({ truncated: false, tree });
    assert.equal(result.emojis.length, 1);
    assert.equal(result.emojis[0].filename, gif.path);
    assert.equal(result.emojis[0].sha, gif.sha);
    assert.equal(result.emojis[0].extension, 'gif');
  }
});

test('accepts punctuation in actual filenames but rejects control characters and unsupported assets', () => {
  const result = catalogFromTree({
    truncated: false,
    tree: [treeEntry(0, "bufo's-coffee+1"), { ...treeEntry(1), path: 'untrusted.svg' }, { ...treeEntry(2), mode: '120000' }]
  });
  assert.equal(result.emojis.length, 1);
  assert.equal(result.emojis[0].name, "bufo's-coffee+1");
  assert.throws(() => catalogFromTree({ truncated: false, tree: [treeEntry(0, 'bad\nname')] }));
});

test('validates local catalog IDs, names, digests, extensions, and sizes', () => {
  assert.equal(validateCatalog(catalog(1)).source, SOURCE_REPO);
  for (const patch of [
    { id: '../../etc' }, { sha: 'not-a-digest' }, { name: 'x\nbad' },
    { filename: '../outside.png' }, { extension: 'svg' }, { size: 8_000_001 }, { size: 0 }
  ]) {
    const value = catalog(1);
    Object.assign(value.emojis[0], patch);
    assert.throws(() => validateCatalog(value), { code: 'INVALID_CATALOG' });
  }
  const duplicate = catalog(1);
  duplicate.emojis.push(duplicate.emojis[0]);
  assert.throws(() => validateCatalog(duplicate), { code: 'INVALID_CATALOG' });
});

test('missing and malformed catalogs give actionable errors', async t => {
  const dataDir = await temporary(t);
  const store = createCatalogStore({ dataDir });
  await assert.rejects(store.get(), { code: 'CATALOG_MISSING' });
  await writeFile(join(dataDir, 'catalog.json'), 'not JSON');
  await assert.rejects(store.get(), { code: 'INVALID_CATALOG' });
});

test('local and public stores reject legacy catalogs even when their image bytes are cached', async t => {
  const dataDir = await temporary(t);
  const value = { ...catalog(1), source: 'github/slack-emoji' };
  await writeFile(join(dataDir, 'catalog.json'), JSON.stringify(value));
  await mkdir(join(dataDir, 'images'));
  await writeFile(join(dataDir, 'images', `${value.emojis[0].sha}.png`), imageBytes(0));
  for (const readOnly of [false, true]) {
    const store = createCatalogStore({
      dataDir, readOnly, api: async () => assert.fail('Legacy catalogs must never fetch images')
    });
    await assert.rejects(store.get(), { code: 'INVALID_CATALOG' });
    await assert.rejects(store.image(value.emojis[0].id), { code: 'INVALID_CATALOG' });
  }
});

test('downloads images once on demand, verifies Git blob hashes, and caches privately', async t => {
  const dataDir = await temporary(t);
  await writeFile(join(dataDir, 'catalog.json'), JSON.stringify(catalog(1)));
  let downloads = 0;
  const store = createCatalogStore({
    dataDir,
    api: async (path, raw) => {
      assert.equal(path, `repos/${SOURCE_REPO}/git/blobs/${emoji(0).sha}`);
      assert.equal(raw, true);
      downloads += 1;
      return imageBytes(0);
    }
  });
  const [first, second] = await Promise.all([store.image(emoji(0).id), store.image(emoji(0).id)]);
  assert.equal(downloads, 1);
  assert.equal(first.type, 'image/png');
  assert.deepEqual(first.bytes, second.bytes);
  await store.image(emoji(0).id);
  assert.equal(downloads, 1);
  assert.equal((await stat(join(dataDir, 'images', `${emoji(0).sha}.png`))).mode & 0o077, 0);
  await assert.rejects(store.image('f'.repeat(20)), { code: 'NOT_FOUND' });
});

test('does not accept non-image bytes or a mismatched image hash', async t => {
  const dataDir = await temporary(t);
  await writeFile(join(dataDir, 'catalog.json'), JSON.stringify(catalog(1)));
  for (const bytes of [Buffer.from('<svg onload="alert(1)"></svg>'), imageBytes(9)]) {
    const store = createCatalogStore({ dataDir, api: async () => bytes });
    await assert.rejects(store.image(emoji(0).id), { code: 'INVALID_IMAGE' });
  }
  assert.equal(imageType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(imageType(Buffer.from([255, 216, 255])), 'image/jpeg');
  assert.equal(imageType(Buffer.from('RIFF1234WEBP')), 'image/webp');
  assert.equal(imageType(Buffer.from('<svg>')), null);
});

test('serves the verified image MIME type even when the source filename has a different extension', async t => {
  const dataDir = await temporary(t);
  const bytes = Buffer.from('RIFF1234WEBP');
  const value = catalog(1);
  value.emojis[0].size = bytes.length;
  value.emojis[0].sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  await writeFile(join(dataDir, 'catalog.json'), JSON.stringify(value));
  let downloads = 0;
  const store = createCatalogStore({ dataDir, api: async () => { downloads += 1; return bytes; } });
  assert.equal((await store.image(value.emojis[0].id)).type, 'image/webp');
  assert.equal((await store.image(value.emojis[0].id)).type, 'image/webp');
  assert.equal(downloads, 1);
});

test('bounds simultaneous GitHub image downloads to four', async t => {
  const dataDir = await temporary(t);
  const value = catalog(12);
  await writeFile(join(dataDir, 'catalog.json'), JSON.stringify(value));
  let active = 0;
  let maximum = 0;
  const store = createCatalogStore({
    dataDir,
    api: async path => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      const index = value.emojis.findIndex(entry => path.endsWith(entry.sha));
      return imageBytes(index);
    }
  });
  await Promise.all(value.emojis.map(entry => store.image(entry.id)));
  assert.equal(maximum, 4);
});

test('hosted GitHub access authenticates on the server and supports JSON and raw blobs', async () => {
  const calls = [];
  const api = githubHttpApi('test-github-token', async (url, options) => {
    calls.push({ url, options });
    return options.headers.Accept.includes('.raw') ? new Response(imageBytes()) : Response.json({ truncated: false, tree: [] });
  });
  const result = await api(`repos/${SOURCE_REPO}/git/trees/main`);
  assert.deepEqual(result, { truncated: false, tree: [] });
  const bytes = await api(`repos/${SOURCE_REPO}/git/blobs/${emoji(0).sha}`, true);
  assert.deepEqual(bytes, imageBytes());
  assert.equal(calls[0].url, `https://api.github.com/repos/${SOURCE_REPO}/git/trees/main`);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-github-token');
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(api('https://untrusted.invalid/token'), { code: 'INVALID_SOURCE' });
  await assert.rejects(api('repos/another/repo/git/trees/main'), { code: 'INVALID_SOURCE' });
  await assert.rejects(api('repos/github/slack-emoji/git/trees/main'), { code: 'INVALID_SOURCE' });
  await assert.rejects(api(`repos/github/slack-emoji/git/blobs/${emoji(0).sha}`, true), { code: 'INVALID_SOURCE' });
  assert.equal(calls.length, 2);
});

test('hosted GitHub failures do not expose tokens or upstream error bodies', async () => {
  for (const fetchImpl of [
    async () => new Response('secret upstream data', { status: 403 }),
    async () => { throw new Error('secret upstream data'); }
  ]) {
    await assert.rejects(githubHttpApi('test-secret', fetchImpl)(`repos/${SOURCE_REPO}/git/trees/main`), error => {
      assert.equal(error.code, 'GITHUB_ACCESS');
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }
  await assert.rejects(
    githubHttpApi('test-secret', async () => new Response('invalid JSON'))(`repos/${SOURCE_REPO}/git/trees/main`),
    { code: 'INVALID_SOURCE' }
  );
});
