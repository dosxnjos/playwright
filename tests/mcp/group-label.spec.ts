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

import { test, expect } from './fixtures';

// browser_set_group_label only makes sense when connected via --extension
// (it labels the extension's tab group for this connection). The default
// test fixture launches a plain isolated/persistent browser with no
// extension relay, so this exercises the "not connected via --extension"
// path without needing a real browser extension - see
// tests/extension/group-label.spec.ts for the extension-dependent behavior
// (title actually changes, dedupe across connections).
//
// That path is a no-op, not an error: agents are instructed to call this tool
// first, before navigating, and an error there reads as a real failure and
// burns a tool call for nothing.
test('no-ops when not running with --extension', async ({ client }) => {
  const response = await client.callTool({
    name: 'browser_set_group_label',
    arguments: { label: 'My Task' },
  });
  expect(response).toHaveResponse({
    result: expect.stringContaining('not running with --extension'),
  });
  // Checked on the raw response on purpose: toHaveResponse() strips every key
  // the expected object doesn't mention, so an expectation without `isError`
  // cannot fail on an errored response (e.g. one carrying a drained unhandled
  // rejection alongside the text).
  expect(response.isError).toBeFalsy();
});

// The error branch is the only detector of a misconfigured extension session:
// --extension was asked for, but another browser mode (isolated, cdpEndpoint)
// won the precedence in browserFactory, or the relay was never wired through -
// so no relay reaches the session even though the user expects the extension.
// Without this test, deleting that branch would leave the whole suite green.
test('errors when --extension was asked for but no relay arrived', async ({ startClient }) => {
  const { client } = await startClient({ args: ['--extension', '--isolated'] });
  const response = await client.callTool({
    name: 'browser_set_group_label',
    arguments: { label: 'My Task' },
  });
  expect(response.isError).toBeTruthy();
  expect(response).toHaveResponse({
    isError: true,
    error: expect.stringContaining('no extension relay is connected'),
  });
});

test('requires a non-empty label', async ({ client }) => {
  expect(await client.callTool({
    name: 'browser_set_group_label',
    arguments: { label: '' },
  })).toHaveResponse({
    isError: true,
  });
});
