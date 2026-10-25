import { test, expect } from '@playwright/test';

test('cursor pages replace the rendered window and preserve navigation', async ({ page, request }) => {
  await page.setViewportSize({ width: 1365, height: 775 });
  const initial = await (await request.get('/api/library?limit=60')).json();
  expect(initial.total).toBeGreaterThan(120);
  expect(initial.documents).toHaveLength(60);
  expect(initial.next_cursor).toBeTruthy();
  const next = await (await request.get('/api/library?limit=60&cursor=' + encodeURIComponent(initial.next_cursor))).json();
  expect(next.documents).toHaveLength(60);
  expect(next.documents.some((d: any) => initial.documents.some((old: any) => old.document_id === d.document_id))).toBe(false);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your knowledge', exact: true })).toBeVisible();
  await expect(page.locator('.file-row')).toHaveCount(60);
  const footer = await page.locator('.browse-footer').boundingBox();
  expect(footer!.height).toBeLessThan(64);
  const first = await page.locator('.file-row').first().getAttribute('data-document-id');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(60);
  await expect(page.locator('.file-row').first()).not.toHaveAttribute('data-document-id', first!);
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.locator('.file-row').first()).toHaveAttribute('data-document-id', first!);
});

test('search and previews expose durable jobs before completed artifacts', async ({ request, baseURL }) => {
  const submitted = await request.post('/api/search', { data: { query: 'grep -F version', mode: 'grep', limit: 10, evaluate: false }, headers: { 'X-Symbiknow-UI': '1', Origin: baseURL! } });
  expect(submitted.ok()).toBe(true);
  const job = await submitted.json();
  expect(job.job_id).toBeTruthy();
  await expect.poll(async () => (await (await request.get('/api/job?id=' + job.job_id)).json()).status).toBe('completed');
  const result = await (await request.get('/api/job?id=' + job.job_id)).json();
  expect(result.result.matches.length).toBeGreaterThan(0);
  const original = await (await request.get('/api/library?limit=100&folder=Engineering')).json();
  const image = original.documents.find((d: any) => d.mime_type.startsWith('image/'));
  expect(image).toBeTruthy();
  const query = 'id=' + image.document_id + '&version=' + image.version;
  const preview = await (await request.get('/api/preview-ready?' + query)).json();
  if (preview.job_id) await expect.poll(async () => (await (await request.get('/api/job?id=' + preview.job_id)).json()).status).toBe('completed');
  const bytes = await request.get('/api/thumbnail?' + query);
  expect(bytes.headers()['content-type']).toContain('image/jpeg');
  expect((await bytes.body()).length).toBeGreaterThan(0);
});
