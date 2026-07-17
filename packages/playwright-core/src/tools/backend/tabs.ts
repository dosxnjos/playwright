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
import { renderTabsMarkdown } from './response';

const browserTabs = defineTool({
  capability: 'core-tabs',

  schema: {
    name: 'browser_tabs',
    title: 'Manage tabs',
    description: 'List, create, close, or select a browser tab. There is a single "current tab" per connection, shared by every caller using this connection (including concurrent sub-agents of the same session) — opening a new tab always makes it current, silently displacing whatever tab another caller was using. If more than one agent/sub-agent may be acting through this connection at the same time, call `list` and `select` your own tab explicitly by index before every action instead of assuming the current tab is yours.',
    inputSchema: z.object({
      action: z.enum(['list', 'new', 'close', 'select']).describe('Operation to perform'),
      index: z.number().optional().describe('Tab index, used for close/select. If omitted for close, the shared current tab is closed — pass an explicit index whenever another caller might be using a different tab on this same connection.'),
      url: z.string().optional().describe('URL to navigate to in the new tab, used for new.'),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    switch (params.action) {
      case 'list': {
        await context.ensureTab();
        break;
      }
      case 'new': {
        const tab = await context.newTab();
        if (params.url) {
          const url = await tab.checkUrlAndNavigate(params.url);
          response.setIncludeSnapshot();
          response.addCode(`await page.goto('${url}');`);
        }
        break;
      }
      case 'close': {
        await context.closeTab(params.index);
        break;
      }
      case 'select': {
        if (params.index === undefined)
          throw new Error('Tab index is required');
        await context.selectTab(params.index);
        break;
      }
    }
    const tabHeaders = await Promise.all(context.tabs().map(tab => tab.headerSnapshot()));
    const result = renderTabsMarkdown(tabHeaders);
    response.addTextResult(result.join('\n'));
  },
});

export default [
  browserTabs,
];
