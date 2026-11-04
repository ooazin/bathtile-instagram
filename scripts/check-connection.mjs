// Confirms the token and account ID work, without posting anything or printing the token.
// Env: IG_ACCESS_TOKEN, IG_USER_ID
const API = 'https://graph.facebook.com/v26.0';
const { IG_ACCESS_TOKEN: token, IG_USER_ID: userId } = process.env;
if (!token) throw new Error('IG_ACCESS_TOKEN is empty');
if (!userId) throw new Error('IG_USER_ID is empty');

async function get(endpoint, fields) {
  const url = new URL(`${API}/${endpoint}`);
  url.searchParams.set('fields', fields);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(`${endpoint}: ${body.error?.message ?? res.status}`);
  return body;
}

const { data: accounts = [] } = await get('me/assigned_instagram_accounts', 'id,username');
console.log('Assigned accounts:', accounts.map((a) => `${a.username} (${a.id})`).join(', ') || 'none');
if (!accounts.some((a) => a.id === userId)) throw new Error('IG_USER_ID is not among the assigned accounts');

const { data: limit = [] } = await get(`${userId}/content_publishing_limit`, 'quota_usage,config');
console.log('Publishing quota:', JSON.stringify(limit[0] ?? {}));
console.log('Connection OK. Nothing was posted.');
