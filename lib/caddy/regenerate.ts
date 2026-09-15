/**
 * Instance-level Caddy config regeneration.
 *
 * When STATIC_PROXY=true, regenerates the Caddyfile from the deployment
 * routing table and reloads Caddy. Called after publish/unpublish.
 *
 * Generates three types of server blocks:
 * 1. Main instance domain (inst-1.oswstudio.com)
 * 2. Subdomain routes (sunny-oak-river.inst-1.oswstudio.com) — wildcard cert
 * 3. Custom domain routes (sweetcandies.com) — on-demand TLS, plus a
 *    www counterpart block (www.sweetcandies.com, or the apex when the stored
 *    domain is a www name) that redirects to the stored name
 *
 * Does nothing if STATIC_PROXY is not set.
 */

import { getAllDomainRoutes, getAllSlugRoutes } from '@/lib/auth/system-database';

const CADDY_ADMIN_API = process.env.CADDY_ADMIN_API || 'http://localhost:2019';

export interface CaddyConfig {
  domain: string;
  publicRoot: string;
  slugRoutes: { deployment_id: string; slug: string }[];
  customDomainRoutes: { deployment_id: string; custom_domain: string }[];
}

/**
 * The www counterpart of a custom domain: `example.com` → `www.example.com`,
 * `www.example.com` → `example.com`. A non-www subdomain (`shop.example.com`)
 * gets `www.shop.example.com`; that is harmless since a cert is only issued
 * when a request for that exact name arrives and the resolver approves it.
 */
export function wwwCounterpart(domain: string): string {
  const d = domain.toLowerCase();
  return d.startsWith('www.') ? d.slice(4) : `www.${d}`;
}

export function generateCaddyfile(config: CaddyConfig): string {
  const { domain, publicRoot, slugRoutes, customDomainRoutes } = config;
  const lines: string[] = [];

  // Global options
  lines.push('{');
  lines.push('  admin localhost:2019 {');
  lines.push('    origins localhost:2019');
  lines.push('  }');
  if (customDomainRoutes.length > 0) {
    lines.push('  on_demand_tls {');
    lines.push('    ask http://localhost:3000/api/resolve-domain');
    lines.push('  }');
  }
  lines.push('}');
  lines.push('');

  // Main instance domain
  lines.push(`${domain} {`);
  lines.push('  handle /deployments/* {');
  lines.push(`    root * ${publicRoot}`);
  lines.push('    try_files {path} {path}.html {path}/index.html');
  lines.push('    file_server');
  lines.push('    header Cache-Control "public, max-age=3600"');
  lines.push('  }');
  lines.push('');
  lines.push('  reverse_proxy localhost:3000');
  lines.push('}');
  lines.push('');

  // Subdomain routes — specific blocks before the wildcard
  for (const route of slugRoutes) {
    lines.push(`${route.slug}.${domain} {`);
    lines.push(`  root * ${publicRoot}`);
    lines.push(`  rewrite * /deployments/${route.deployment_id}{uri}`);
    lines.push('  try_files {path} {path}.html {path}/index.html');
    lines.push('  file_server');
    lines.push('  header Cache-Control "public, max-age=3600"');
    lines.push('}');
    lines.push('');
  }

  // Wildcard subdomain block: terminates TLS for any *.domain host without an
  // explicit block above and proxies it to Node. This does NOT serve a
  // deployment — Node serves deployments by /deployments/{id}/ path only, not by
  // host — so an unmatched subdomain reaches the main app, not its site. Its
  // purpose is a valid wildcard cert instead of a TLS error; a deployment's
  // subdomain only serves its site once its explicit block above exists.
  if (slugRoutes.length > 0) {
    lines.push(`*.${domain} {`);
    lines.push('  tls {');
    lines.push('    dns cloudflare {env.CLOUDFLARE_API_TOKEN}');
    lines.push('  }');
    lines.push('  reverse_proxy localhost:3000');
    lines.push('}');
    lines.push('');
  }

  // Custom domain routes
  for (const route of customDomainRoutes) {
    lines.push(`${route.custom_domain} {`);
    lines.push('  tls {');
    lines.push('    on_demand');
    lines.push('  }');
    lines.push(`  root * ${publicRoot}`);
    lines.push(`  rewrite * /deployments/${route.deployment_id}{uri}`);
    lines.push('  try_files {path} {path}.html {path}/index.html');
    lines.push('  file_server');
    lines.push('  header Cache-Control "public, max-age=3600"');
    lines.push('}');
    lines.push('');

    // www counterpart → permanent redirect to the stored (canonical) name
    lines.push(`${wwwCounterpart(route.custom_domain)} {`);
    lines.push('  tls {');
    lines.push('    on_demand');
    lines.push('  }');
    lines.push(`  redir https://${route.custom_domain}{uri} permanent`);
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

export async function regenerateInstanceCaddy(): Promise<void> {
  if (process.env.STATIC_PROXY !== 'true') return;

  try {
    const domain = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000')
      .replace(/^https?:\/\//, '');
    const publicRoot = process.cwd() + '/public';

    const config = generateCaddyfile({
      domain,
      publicRoot,
      slugRoutes: getAllSlugRoutes(),
      customDomainRoutes: getAllDomainRoutes(),
    });

    // Persist to disk so a cold Caddy restart (which loads from the file, not the
    // admin API) picks up the current config. Best-effort — the admin reload below
    // is the primary path — but don't swallow the error: a silent failure leaves a
    // stale file that a restart would load, dropping every route not in it.
    const caddyfilePath = process.env.CADDYFILE_PATH || '/etc/caddy/Caddyfile';
    try {
      const { promises: fs } = await import('fs');
      await fs.writeFile(caddyfilePath, config, 'utf-8');
    } catch (err) {
      console.error(
        `[Caddy] Failed to persist config to ${caddyfilePath} — a Caddy restart will load a stale config until the next successful write:`,
        err instanceof Error ? err.message : err
      );
    }

    // Reload via admin API for immediate effect
    const res = await fetch(`${CADDY_ADMIN_API}/load`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/caddyfile',
        'Origin': `http://localhost:${new URL(CADDY_ADMIN_API).port || '2019'}`,
      },
      body: config,
    });

    if (!res.ok) {
      console.error(`[Caddy] Reload failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error('[Caddy] Config regeneration failed:', err);
  }
}
