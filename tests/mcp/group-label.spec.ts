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
// error path without needing a real browser extension - see
// tests/extension/group-label.spec.ts for the extension-dependent behavior
// (title actually changes, dedupe across connections).
test('errors when not connected via --extension', async ({ client }) => {
  expect(await client.callTool({
    name: 'browser_set_group_label',
    arguments: { label: 'My Task' },
  })).toHaveResponse({
    isError: true,
    error: expect.stringContaining('only works when connected via --extension'),
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
