/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


const BROWSER_STATE_METHODS = new Set([
  'Storage.setCookies',
  'Storage.clearCookies',
  'Network.clearBrowserCookies',
  // Fork (patch 8): the same cookie store through the Network domain; Playwright does not use them.
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCache',
  'Browser.grantPermissions',
  'Browser.resetPermissions',
  'Browser.setPermission',
  'Browser.setDownloadBehavior',
  'Target.createTarget',
  'Target.closeTarget',
  'Target.attachToTarget',
  'Target.activateTarget',
]);

export function checkCdpMethod(method: string, params?: unknown): void {
  // Fork (FORK.md, patch 8): deleting some cookies is allowed, not planting or clearing them all.
  if (method === 'Storage.setCookies' && onlyExpiredCookies(params))
    return;
  if (BROWSER_STATE_METHODS.has(method))
    throw new Error(`${method} is not allowed: it changes the state of the browser, not of the tab`);
}

// Fork-only (patch 8). Playwright's clearCookies() with a filter (browser_cookie_delete) reads the cookies and sets the
// matching ones again with `expires: 0`, through Storage.setCookies (server/browserContext.ts clearCookies). A call in
// which every cookie is already expired can only delete. A missing `expires` or -1 is a session cookie: not expired.
// ClientSession also checks that each cookie is of a site where the client has a tab (cookieSitesOutside).
function onlyExpiredCookies(params: unknown): boolean {
  const cookies = (params as { cookies?: unknown } | undefined)?.cookies;
  if (!Array.isArray(cookies) || !cookies.length)
    return false;
  const now = Date.now() / 1000;
  return cookies.every(cookie => {
    const expires = (cookie as { expires?: unknown } | null)?.expires;
    return typeof expires === 'number' && expires >= 0 && expires <= now;
  });
}

// Fork-only (patch 8): the domains of the cookies of a Storage.setCookies call that are not of a site of `hosts` (the
// hosts of the tabs of the client). Deleting a cookie by name alone would otherwise log the user out of every site that
// has a cookie with that name.
export function cookieSitesOutside(params: unknown, hosts: string[]): string[] {
  const cookies = (params as { cookies?: unknown[] } | undefined)?.cookies ?? [];
  const outside = new Set<string>();
  for (const cookie of cookies) {
    const { domain, url } = (cookie ?? {}) as { domain?: unknown, url?: unknown };
    let site = typeof domain === 'string' ? domain : '';
    if (!site && typeof url === 'string') {
      try {
        site = new URL(url).hostname;
      } catch {
      }
    }
    site = site.replace(/^\./, '').toLowerCase();
    if (!site || !hosts.some(host => host === site || host.endsWith('.' + site) || site.endsWith('.' + host)))
      outside.add(site || '(no domain)');
  }
  return [...outside];
}
