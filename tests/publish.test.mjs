import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClient, findDuePost, run, validatePost } from '../scripts/publish.mjs';

const NOW = new Date('2026-11-10T01:00:00Z');

function setup(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'posts-'));
  const dir = path.join(root, 'demo');
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  const images = ['images/01.jpg', 'images/02.jpg'];
  images.forEach((i) => fs.writeFileSync(path.join(dir, i), 'x'));
  const post = { slug: 'demo', status: 'approved', scheduled_at: '2026-11-10T09:00:00+09:00', caption: '안녕 #타일', images, ...overrides };
  fs.writeFileSync(path.join(dir, 'post.json'), JSON.stringify(post));
  return { root, file: path.join(dir, 'post.json'), read: () => JSON.parse(fs.readFileSync(path.join(dir, 'post.json'), 'utf8')) };
}

function fakeApi({ failPublish = false, statuses = {} } = {}) {
  const calls = [];
  let next = 1;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const params = Object.fromEntries(init.body ?? []);
    calls.push({ method: init.method, path: u.pathname, params, auth: init.headers.Authorization });
    const json = (body, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });
    if (u.pathname.endsWith('/content_publishing_limit')) return json({ data: [{ quota_usage: 1 }] });
    if (u.pathname.endsWith('/media_publish')) return failPublish ? json({ error: { message: 'boom' } }, false) : json({ id: 'M1' });
    if (init.method === 'POST') return json({ id: `C${next++}` });
    if (u.searchParams.get('fields') === 'permalink') return json({ permalink: 'https://instagram.com/p/x' });
    return json({ status_code: statuses[u.pathname.split('/').pop()] ?? 'FINISHED' });
  };
  return { calls, client: createClient({ token: 'T', userId: 'U', fetchImpl, pollMs: 0, maxPolls: 2 }) };
}

test('publishes an approved carousel in API order and records the result', async () => {
  const { root, read } = setup();
  const { calls, client } = fakeApi();
  await run({ postsDir: root, baseUrl: 'https://cdn.test/', client, now: NOW, log: () => {} });

  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts[0].params.image_url, 'https://cdn.test/posts/demo/images/01.jpg');
  assert.equal(posts[0].params.is_carousel_item, 'true');
  assert.equal(posts[2].params.media_type, 'CAROUSEL');
  assert.equal(posts[2].params.children, 'C1,C2');
  assert.equal(posts[2].params.caption, '안녕 #타일');
  assert.equal(posts[3].params.creation_id, 'C3');
  assert.ok(calls.every((c) => c.auth === 'Bearer T'));
  assert.equal(read().status, 'published');
  assert.equal(read().permalink, 'https://instagram.com/p/x');
});

test('never picks drafts or posts scheduled in the future', () => {
  assert.equal(findDuePost(setup({ status: 'draft' }).root, NOW), undefined);
  assert.equal(findDuePost(setup({ scheduled_at: '2026-12-01T09:00:00+09:00' }).root, NOW), undefined);
  assert.equal(findDuePost(setup({ status: 'published' }).root, NOW), undefined);
});

test('dry run makes no API calls and leaves the post unchanged', async () => {
  const { root, read } = setup();
  const { calls, client } = fakeApi();
  await run({ postsDir: root, baseUrl: 'https://cdn.test', client, dryRun: true, now: NOW, log: () => {} });
  assert.equal(calls.length, 0);
  assert.equal(read().status, 'approved');
});

test('a failed publish is held for review and not retried', async () => {
  const { root, read } = setup();
  const { client } = fakeApi({ failPublish: true });
  await assert.rejects(run({ postsDir: root, baseUrl: 'https://cdn.test', client, now: NOW, log: () => {} }), /boom/);
  assert.equal(read().status, 'needs_check');
  assert.equal(findDuePost(root, NOW), undefined);
});

test('a failed image container stops before publishing', async () => {
  const { root, read } = setup();
  const { calls, client } = fakeApi({ statuses: { C1: 'ERROR' } });
  await assert.rejects(run({ postsDir: root, baseUrl: 'https://cdn.test', client, now: NOW, log: () => {} }), /ERROR/);
  assert.ok(!calls.some((c) => c.path.endsWith('/media_publish')));
  assert.equal(read().status, 'approved');
});

test('validation catches bad carousels', () => {
  const { root } = setup();
  const dir = path.join(root, 'demo');
  const base = { caption: 'a', scheduled_at: '2026-11-10T09:00:00+09:00', images: ['images/01.jpg', 'images/02.jpg'] };
  assert.deepEqual(validatePost(base, dir), []);
  assert.match(validatePost({ ...base, images: ['images/01.jpg'] }, dir).join(), /2-10/);
  assert.match(validatePost({ ...base, images: ['images/01.png', 'images/02.jpg'] }, dir).join(), /not a JPEG/);
  assert.match(validatePost({ ...base, images: ['images/01.jpg', 'images/09.jpg'] }, dir).join(), /missing/);
  assert.match(validatePost({ ...base, scheduled_at: null }, dir).join(), /scheduled_at/);
  assert.match(validatePost({ ...base, caption: Array(31).fill('#a').join(' ') }, dir).join(), /hashtags/);
});
