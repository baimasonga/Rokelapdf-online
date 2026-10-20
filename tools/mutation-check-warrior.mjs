import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const copy = mkdtempSync(join(tmpdir(), 'pdf-warrior-mutations-'));
const file = 'src/lib/server/warrior.ts';
const cases = [
  [file, '.strict()', '', true],
  [file, '![this.#config.apiComponentId, this.#config.converterComponentId, this.#config.scannerComponentId].includes(componentId)', 'false'],
  [file, "redirect: 'error',", "redirect: 'follow',"],
  [file, 'a.id === r.id &&', 'true &&'],
  [file, 'if (size > 32768)', 'if (false)'],
  [file, "claim_token=$2 AND state='claimed' AND lease_until>$3", "state='claimed' AND $2::uuid IS NOT NULL AND lease_until>$3"],
  ['src/lib/server/api/routes.ts', "r.add('GET', '/api/v1/admin/monitoring', 'operator'", "r.add('GET', '/api/v1/admin/monitoring', 'user'"],
];
const run = () =>
  spawnSync(process.execPath, [join(copy, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/unit/warrior.test.ts'], {
    cwd: copy,
    env: process.env,
    encoding: 'utf8',
    timeout: 120000,
  });
try {
  for (const dir of ['src', 'tests', 'tools', 'db']) cpSync(join(root, dir), join(copy, dir), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'next-env.d.ts']) cpSync(join(root, name), join(copy, name));
  // This repository has no workspace source packages. Aliases resolve to this copy's src.
  symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  let killed = 0;
  for (const [name, before, after, all] of cases) {
    const path = join(copy, name),
      original = readFileSync(path, 'utf8');
    assert.ok(original.includes(before), `missing anchor ${before}`);
    try {
      writeFileSync(path, all ? original.replaceAll(before, after) : original.replace(before, after));
      const result = run();
      assert.equal(result.signal, null);
      assert.notEqual(result.status, 0, `survived ${before}`);
      assert.match(result.stdout + result.stderr, /AssertionError/);
      killed++;
      console.log('Killed:', before);
    } finally {
      writeFileSync(path, original);
    }
  }
  console.log(`${killed} source adapter security mutations killed.`);
} finally {
  rmSync(copy, { recursive: true, force: true });
}
