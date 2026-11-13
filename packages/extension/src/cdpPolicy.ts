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
