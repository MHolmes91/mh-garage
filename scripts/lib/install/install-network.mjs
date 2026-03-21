import { lookup } from 'node:dns/promises';

import { log, note } from './install-logging.mjs';

async function waitForHttp(url, attempts = 60, sleepMs = 2000, fetchFn = fetch) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchFn(url);
      if (response.ok) {
        return true;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  return false;
}

export async function waitForDokployPanel(stdout) {
  log(stdout, 'Waiting for Dokploy panel');
  if (await waitForHttp('http://127.0.0.1:3000', 90, 2000)) {
    note(stdout, 'Dokploy is reachable on http://127.0.0.1:3000');
    return;
  }

  throw new Error('Dokploy did not become reachable on port 3000 in time.');
}

export async function detectPublicIp() {
  for (const url of ['https://ifconfig.io', 'https://icanhazip.com', 'https://ipecho.net/plain']) {
    try {
      const response = await fetch(url, { headers: { Accept: 'text/plain' } });
      const ip = (await response.text()).trim();
      if (ip) {
        return ip;
      }
    } catch {}
  }

  return '';
}

export async function hostResolvesToAddress(host, expectedIp) {
  try {
    const results = await lookup(host, { all: true, family: 4 });
    return results.some((entry) => entry.address === expectedIp);
  } catch {
    return false;
  }
}

export async function isHttpsReachable(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return response.ok;
  } catch {
    return false;
  }
}
