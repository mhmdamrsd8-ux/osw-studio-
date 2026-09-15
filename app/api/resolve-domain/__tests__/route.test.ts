import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const db = vi.hoisted(() => ({
  getDeploymentByDomain: vi.fn<(d: string) => { deployment_id: string } | undefined>(),
  getDeploymentBySlug: vi.fn<(s: string) => { deployment_id: string } | undefined>(),
  getAllDomainRoutes: vi.fn(() => []),
}));
vi.mock('@/lib/auth/system-database', () => db);

import { GET } from '@/app/api/resolve-domain/route';

/**
 * Caddy asks this route before issuing an on-demand certificate. The www counterpart of a stored
 * domain is served as a redirect to it, so the ask for `www.example.com` has to be approved when
 * only `example.com` is stored, and the other way round; otherwise the redirect host has no cert.
 */
function request(query: string): NextRequest {
  const url = new URL(`http://localhost/api/resolve-domain${query}`);
  return { nextUrl: url } as unknown as NextRequest;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://inst-1.oswstudio.com');
  db.getDeploymentByDomain.mockReset();
  db.getDeploymentBySlug.mockReset();
  // Only the stored name is known to the database.
  db.getDeploymentByDomain.mockImplementation((d) => (d === 'sweetcandies.com' ? { deployment_id: 'dep-1' } : undefined));
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/resolve-domain', () => {
  it('approves the stored domain', async () => {
    const res = await GET(request('?domain=sweetcandies.com'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deploymentId: 'dep-1', path: '/deployments/dep-1' });
  });

  it('approves the www counterpart of a stored apex, which serves the redirect', async () => {
    const res = await GET(request('?domain=www.sweetcandies.com'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ deploymentId: 'dep-1' });
    expect(db.getDeploymentByDomain).toHaveBeenCalledWith('sweetcandies.com');
  });

  it('approves the apex when the stored name is the www form', async () => {
    db.getDeploymentByDomain.mockImplementation((d) => (d === 'www.sweetcandies.com' ? { deployment_id: 'dep-2' } : undefined));

    const res = await GET(request('?domain=sweetcandies.com'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ deploymentId: 'dep-2' });
  });

  it('still refuses an unknown name, so a cert is never issued for it', async () => {
    const res = await GET(request('?domain=www.nothing-here.example'));

    expect(res.status).toBe(404);
  });
});
