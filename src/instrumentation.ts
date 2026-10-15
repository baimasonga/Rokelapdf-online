export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const { container } = await import('./lib/server/container');
  const { startBackground } = await import('./lib/server/worker');
  startBackground(container());
}
