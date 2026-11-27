export async function fetchIssue(serviceUrl, key) {
  const response = await fetch(new URL(`/issues/${key}`, serviceUrl));
  if (!response.ok) throw new Error(`Issue service returned ${response.status}`);
  return response.json();
}
