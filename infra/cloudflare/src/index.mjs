import { Container, getContainer } from '@cloudflare/containers';
import { containerFailure, containerRequest, runtimeEnvironment } from './runtime.mjs';

export class RokelaApp extends Container {
  defaultPort = 3000;
  sleepAfter = '10m';

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = runtimeEnvironment(env);
  }

  // Retention and queued jobs must continue between visitor requests.
  // Cloudflare may still evict/restart the container; no uptime guarantee is implied.
  onActivityExpired() {}

  onStart() {
    console.log(JSON.stringify({ event: 'backup_container_started' }));
  }

  onStop({ exitCode, reason }) {
    console.error(JSON.stringify({ event: 'backup_container_stopped', exit_code: exitCode, reason }));
  }

  async fetch(request) {
    // Loading antivirus definitions takes longer than the SDK's default port wait.
    try {
      await this.startAndWaitForPorts({ ports: [3000], cancellationOptions: { instanceGetTimeoutMS: 120_000, portReadyTimeoutMS: 420_000 } });
    } catch (error) {
      console.error(JSON.stringify({ event: 'backup_startup_failed', ...containerFailure(error) }));
      throw error;
    }
    return super.fetch(request);
  }
}

export default {
  async scheduled(_event, env) {
    if (env.ENABLE_BACKUP !== 'true') return;
    const request = new Request(new URL('/api/v1/health', env.PUBLIC_ORIGIN));
    const response = await getContainer(env.ROKELA_APP, 'backup-app').fetch(request);
    if (!response.ok) throw new Error('Backup health check failed');
  },
  async fetch(request, env) {
    if (env.ENABLE_BACKUP !== 'true') return new Response('Backup is not activated.', { status: 503, headers: { 'cache-control': 'no-store' } });
    try {
      const response = await getContainer(env.ROKELA_APP, 'backup-app').fetch(containerRequest(request, env.PUBLIC_ORIGIN));
      const headers = new Headers(response.headers);
      headers.set('cache-control', 'private, no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      console.error(JSON.stringify({ event: 'backup_request_failed', ...containerFailure(error) }));
      return new Response('Backup application unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } });
    }
  },
};
