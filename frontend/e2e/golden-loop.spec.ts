import { expect, test, type APIRequestContext } from '@playwright/test';

// Demo users seeded by config.yaml (dev only).
const OPERATOR = { username: 'operator', password: 'operator-demo' };
const API = 'http://localhost:8000';
const SENSOR = 'temp-sensor-204';
const ROOM = 'room204';

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/api/auth/login`, { data: OPERATOR });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).access_token;
}

/** The detector needs ~60 s of history per sensor before it will judge a reading. */
async function waitForWarmUp(request: APIRequestContext) {
  await expect
    .poll(
      async () => {
        const end = new Date();
        const start = new Date(end.getTime() - 15 * 60_000);
        const res = await request.get(`${API}/api/replay`, {
          params: { start: start.toISOString(), end: end.toISOString() },
        });
        const body = await res.json();
        const pts =
          body.sensors.find((s: { sensor_id: string }) => s.sensor_id === SENSOR)?.points ?? [];
        return pts.length ? (end.getTime() - Date.parse(pts[0].t)) / 1000 : 0;
      },
      {
        timeout: 150_000,
        intervals: [3_000],
        message: 'waiting for the simulator to build a baseline',
      }
    )
    .toBeGreaterThan(75);
}

test('golden loop: health → topology → inject spike → anomaly → ack/resolve → time travel → reload', async ({
  page,
  request,
}) => {
  // 1. Backend is healthy.
  const health = await request.get(`${API}/health`);
  expect(health.ok()).toBeTruthy();
  expect((await health.json()).database).toBe('connected');

  // 2. The topology loads in the UI and the live stream connects.
  await page.goto('/observe');
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'live');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const table = page.getByRole('table', { name: /Building rooms and equipment/ });
  await expect(table.getByRole('row', { name: /Room 204/ })).toBeVisible();
  await expect(table.getByRole('row', { name: /Room 101/ })).toBeVisible();
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.locator('canvas')).toBeVisible();

  // 3. Sign in as an operator through the real dialog.
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Username').fill(OPERATOR.username);
  await page.getByLabel('Password').fill(OPERATOR.password);
  await page.getByRole('dialog').getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('operator').first()).toBeVisible();

  // 4. Inject a spike once the detector has a baseline.
  await waitForWarmUp(request);
  const token = await login(request);
  const inject = await request.post(`${API}/api/simulator/inject`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { sensor_id: SENSOR, kind: 'spike', duration_seconds: 40, magnitude: 14 },
  });
  expect(inject.ok()).toBeTruthy();

  // 5. The anomaly appears in the scene (toast + outline marker) and in the inspector.
  const toast = page.locator('.toast.anomaly');
  await expect(toast).toBeVisible({ timeout: 40_000 });
  await expect(toast).toContainText(ROOM);
  await expect(
    page.getByRole('button', { name: new RegExp(`open anomal.*in Room 204`, 'i') })
  ).toBeVisible();
  await toast.getByRole('link', { name: 'Investigate' }).click();
  await expect(page).toHaveURL(/\/investigate/);
  await expect(page.getByText('Why it was flagged')).toBeVisible();
  await expect(page.getByText('Scenario-injected').first()).toBeVisible();

  const anomalies = await (
    await request.get(`${API}/api/anomalies`, { params: { sensor_id: SENSOR, status: 'OPEN' } })
  ).json();
  expect(anomalies.length).toBeGreaterThan(0);
  const anomalyId: number = anomalies[0].id;

  // 6. Acknowledge, then resolve. The UI changes only after the backend confirms.
  await page.getByRole('button', { name: 'Acknowledge', exact: true }).click();
  await expect(page.locator('.panel-stack .badge', { hasText: /^ACKNOWLEDGED$/ })).toBeVisible();
  expect((await (await request.get(`${API}/api/anomalies/${anomalyId}`)).json()).status).toBe(
    'ACKNOWLEDGED'
  );

  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.locator('.panel-stack .badge', { hasText: /^RESOLVED$/ })).toBeVisible();
  const resolved = await (await request.get(`${API}/api/anomalies/${anomalyId}`)).json();
  expect(resolved.status).toBe('RESOLVED');
  expect(resolved.acknowledged_by).toBe('operator');

  // 7. Scrub the timeline back to the event.
  await page.getByRole('button', { name: /Timeline/ }).click();
  const marker = page
    .getByRole('button', {
      name: new RegExp(`anomaly ${anomalyId} (open|acknowledged|resolved)`, 'i'),
    })
    .first();
  await expect(marker).toBeVisible();
  // Markers of events seconds apart overlap on a 1 h scale, so a pointer click can land on a
  // neighbour; activate this exact marker (what a keyboard user does).
  await marker.dispatchEvent('click');
  await expect(page.getByText('TIME TRAVEL')).toBeVisible();
  await expect(page).toHaveURL(/[?&]t=/);
  await expect(page.getByRole('button', { name: 'Return to live' })).toBeVisible();

  // 8. After a refresh the history is still there and the cursor is restored from the URL.
  await page.reload();
  await expect(page.getByText('TIME TRAVEL')).toBeVisible();
  await expect(page.getByRole('table', { name: /lifecycle events/ })).toContainText('RESOLVED');
  await page.getByRole('button', { name: 'Return to live' }).first().click();
  await expect(page.getByText('TIME TRAVEL')).toHaveCount(0);
});
