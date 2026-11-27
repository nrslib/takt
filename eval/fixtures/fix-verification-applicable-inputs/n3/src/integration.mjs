export async function fetchPullRequest(endpoint) {
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body.title !== 'string') throw new Error('タイトルが不正です');
  return body;
}
