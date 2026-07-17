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

import * as z from 'zod';
import { defineTool } from './tool';

const setGroupLabel = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_set_group_label',
    title: 'Label this session\'s browser tab group',
    description: 'Set a short custom label for this session\'s browser tab group in the Playwright extension, so the user can tell which task/agent owns which tabs when multiple sessions are connected at once. Call this once, early in a task, when you expect to use the browser - especially if the user is likely running you alongside other Claude Code instances. Only has an effect when connected via --extension; errors otherwise.',
    inputSchema: z.object({
      label: z.string().min(1).describe('Short label for the tab group, e.g. the task name. Shown as "Playwright · <label>" in the browser; deduped with a (2)/(3) suffix if another active connection already used it.'),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    const relay = context.extensionRelay();
    if (!relay)
      throw new Error('browser_set_group_label only works when connected via --extension');
    await relay.setGroupLabel(params.label);
    response.addTextResult(`Tab group label set to "${params.label}".`);
  },
});

export default [
  setGroupLabel,
];
