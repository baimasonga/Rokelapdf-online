import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRouter } from '@/lib/server/api/routes';

const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('deployment configuration', () => {
  const railway = json('railway.json');
  const pkg = json('package.json');

  it('runs migrations and grants before every deploy through a script that exists', () => {
    expect(railway.deploy.preDeployCommand).toEqual(['npm run deploy:prepare']);
    expect(pkg.scripts['deploy:prepare']).toBe('tsx tools/admin.ts migrate && tsx tools/admin.ts grants');
    expect(pkg.dependencies.tsx).toBeDefined(); // available in the production image, not only in dev
    expect(railway.deploy.startCommand).toBe('npm start');
  });

  it('health-checks a real public route', () => {
    const route = buildRouter().routes.find((r) => r.method === 'GET' && '/' + r.parts.join('/') === railway.deploy.healthcheckPath);
    expect(route?.mode).toBe('public');
  });

  it('points the ClamAV service at its Dockerfile', () => {
    const clam = json('infra/clamav/railway.json');
    expect(existsSync(clam.build.dockerfilePath)).toBe(true);
    expect(readFileSync(clam.build.dockerfilePath, 'utf8')).toMatch(/StreamMaxLength 300M/);
  });
});
