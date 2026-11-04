// Publishes the next approved, due post through the Instagram API. At most one post per run.
// Usage: node scripts/publish.mjs [--dry-run]
// Env: IG_ACCESS_TOKEN, IG_USER_ID, PUBLIC_BASE_URL (public root that serves the posts/ folder)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://graph.facebook.com/v26.0';
const MAX_SLIDES = 10;
const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 30;
const DAILY_LIMIT = 50;

export function validatePost(post, postDir) {
  const errors = [];
  if (!post.caption) errors.push('caption is empty');
  if (post.caption?.length > MAX_CAPTION) errors.push(`caption is over ${MAX_CAPTION} characters`);
  if ((post.caption?.match(/#\S+/g) ?? []).length > MAX_HASHTAGS) errors.push(`more than ${MAX_HASHTAGS} hashtags`);
  if (!Array.isArray(post.images) || post.images.length < 2 || post.images.length > MAX_SLIDES) {
    errors.push(`carousel needs 2-${MAX_SLIDES} images`);
  }
  for (const image of post.images ?? []) {
    if (!/\.jpe?g$/i.test(image)) errors.push(`${image} is not a JPEG`);
    if (!fs.existsSync(path.join(postDir, image))) errors.push(`${image} is missing`);
  }
  if (Number.isNaN(Date.parse(post.scheduled_at))) errors.push('scheduled_at is not a valid date');
  return errors;
}

export function findDuePost(postsDir, now = new Date()) {
  return fs.readdirSync(postsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(postsDir, d.name, 'post.json')))
    .map((d) => {
      const file = path.join(postsDir, d.name, 'post.json');
      return { file, dir: path.join(postsDir, d.name), post: JSON.parse(fs.readFileSync(file, 'utf8')) };
    })
    .filter(({ post }) => post.status === 'approved' && Date.parse(post.scheduled_at) <= now.getTime())
    .sort((a, b) => Date.parse(a.post.scheduled_at) - Date.parse(b.post.scheduled_at))[0];
}

export function createClient({ token, userId, fetchImpl = fetch, pollMs = 60000, maxPolls = 6 }) {
  async function call(method, endpoint, params = {}) {
    const url = new URL(`${API}/${endpoint}`);
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (method === 'GET') {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    } else {
      init.body = new URLSearchParams(params);
    }
    const res = await fetchImpl(url, init);
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(`${method} ${endpoint}: ${body.error?.message ?? res.status}`);
    return body;
  }

  async function waitUntilReady(id) {
    for (let i = 0; i < maxPolls; i++) {
      const { status_code: status } = await call('GET', id, { fields: 'status_code' });
      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Container ${id} is ${status}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`Container ${id} was not ready in time`);
  }

  return {
    async remainingToday() {
      const { data } = await call('GET', `${userId}/content_publishing_limit`, { fields: 'quota_usage' });
      return DAILY_LIMIT - (data?.[0]?.quota_usage ?? 0);
    },
    async prepareCarousel(imageUrls, caption) {
      const children = [];
      for (const image_url of imageUrls) {
        const { id } = await call('POST', `${userId}/media`, { image_url, is_carousel_item: 'true' });
        await waitUntilReady(id);
        children.push(id);
      }
      const { id } = await call('POST', `${userId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption });
      await waitUntilReady(id);
      return id;
    },
    async publish(creationId) {
      const { id } = await call('POST', `${userId}/media_publish`, { creation_id: creationId });
      const { permalink } = await call('GET', id, { fields: 'permalink' }).catch(() => ({}));
      return { id, permalink };
    },
  };
}

const save = (file, post) => fs.writeFileSync(file, `${JSON.stringify(post, null, 2)}\n`);

export async function run({ postsDir, baseUrl, client, dryRun = false, now = new Date(), log = console.log }) {
  const due = findDuePost(postsDir, now);
  if (!due) {
    log('No approved post is due.');
    return null;
  }
  const { file, dir, post } = due;
  const errors = validatePost(post, dir);
  if (errors.length) throw new Error(`${post.slug}: ${errors.join('; ')}`);

  const urls = post.images.map((image) => `${baseUrl.replace(/\/$/, '')}/posts/${encodeURIComponent(post.slug)}/${image}`);
  if (dryRun) {
    log(`[dry-run] Would publish ${post.slug} with ${urls.length} images:\n${urls.join('\n')}`);
    return post;
  }

  if ((await client.remainingToday()) <= 0) throw new Error('Daily publishing limit reached');
  const creationId = await client.prepareCarousel(urls, post.caption);

  // Past this point a failure may still have posted, so it is held for a person rather than retried.
  try {
    const { id, permalink } = await client.publish(creationId);
    Object.assign(post, { status: 'published', published_at: now.toISOString(), media_id: id, permalink: permalink ?? null });
    save(file, post);
    log(`Published ${post.slug}: ${permalink ?? id}`);
    return post;
  } catch (error) {
    Object.assign(post, { status: 'needs_check', error: error.message });
    save(file, post);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  const { IG_ACCESS_TOKEN: token, IG_USER_ID: userId, PUBLIC_BASE_URL: baseUrl = 'https://example.invalid' } = process.env;
  const postsDir = path.resolve('posts');
  // Only a due post needs credentials, so idle scheduled runs pass before setup is finished.
  if (!dryRun && findDuePost(postsDir) && (!token || !userId || !process.env.PUBLIC_BASE_URL)) {
    throw new Error('IG_ACCESS_TOKEN, IG_USER_ID and PUBLIC_BASE_URL are required');
  }
  await run({ postsDir, baseUrl, client: createClient({ token, userId }), dryRun });
}
