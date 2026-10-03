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

import path from 'path';

import debug from 'debug';
import * as z from 'zod';
import { formatObject } from '@isomorphic/stringUtils';
import { monotonicTime } from '@isomorphic/time';

import { defineTabTool } from './tool';
import { optionalElementSchema } from './snapshot';
import { extensionRelayFor } from './extensionSession';

import type * as playwright from '../../..';
import type { ContextConfig } from './context';

const shotDebug = debug('pw:mcp:shot');

// Fork-only (patch 7). A sub-agent's tab is created in the background and never shown; through the extension its
// capture took 4-5 s on 03/10/2026 and failed at the 5 s action timeout (FORK.md § Silent connect).
const backgroundScreenshotTimeout = 30_000;

export function screenshotTimeout(config: Pick<ContextConfig, 'timeouts'>, background: boolean): number | undefined {
  const action = config.timeouts?.action;
  return background ? Math.max(action ?? 0, backgroundScreenshotTimeout) : action;
}

// Fork-only (patch 7): the relay is registered for the tab's Browser (backend/extensionSession.ts), never its context.
type ScreenshotTab = { page: { context(): { browser(): object | null } }, context: { config: Pick<ContextConfig, 'timeouts'> } };

export function screenshotTimeoutFor(tab: ScreenshotTab): { background: boolean, timeout: number | undefined } {
  const background = !!extensionRelayFor(tab.page.context().browser())?.background;
  return { background, timeout: screenshotTimeout(tab.context.config, background) };
}

type ImageFormat = 'png' | 'jpeg' | 'webp';

const screenshotSchema = optionalElementSchema.extend({
  type: z.enum(['png', 'jpeg', 'webp']).optional().describe('Image format for the screenshot. If unset, inferred from the filename extension, otherwise png.'),
  filename: z.string().optional().describe('File name to save the screenshot to. Relative file names are resolved against the workspace root. If not specified, the screenshot is saved into the output directory as `page-{timestamp}.{png|jpeg|webp}`.'),
  fullPage: z.boolean().optional().describe('When true, takes a screenshot of the full scrollable page, instead of the currently visible viewport. Cannot be used with element screenshots.'),
  scale: z.enum(['css', 'device']).default('css').describe('Image resolution scale. "css" produces a screenshot sized in CSS pixels (smaller, consistent across devices). "device" produces a high-resolution screenshot using device pixels (larger, accounts for the device pixel ratio). Default is css.'),
});

function inferTypeFromFilename(filename: string | undefined): ImageFormat | undefined {
  if (!filename)
    return undefined;
  switch (path.extname(filename).toLowerCase()) {
    case '.png': return 'png';
    case '.jpg':
    case '.jpeg': return 'jpeg';
    case '.webp': return 'webp';
  }
  return undefined;
}

const screenshot = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_take_screenshot',
    title: 'Take a screenshot',
    description: `Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions.`,
    inputSchema: screenshotSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    if (params.fullPage && params.target)
      throw new Error('fullPage cannot be used with element screenshots.');

    const fileType: ImageFormat = params.type ?? inferTypeFromFilename(params.filename) ?? 'png';
    // Fork (patch 7): a sub-agent's background tab captures slowly through the extension.
    const { background, timeout } = screenshotTimeoutFor(tab);
    const options: playwright.PageScreenshotOptions = {
      type: fileType,
      quality: fileType === 'jpeg' ? 90 : undefined,
      scale: params.scale,
      timeout,
      ...(params.fullPage !== undefined && { fullPage: params.fullPage })
    };

    const screenshotTargetLabel = params.target ? params.element || 'element' : (params.fullPage ? 'full page' : 'viewport');
    const target = params.target ? await tab.targetLocator({ element: params.element, target: params.target }) : null;
    const startTime = monotonicTime();
    let outcome = 'failed';
    let data: Buffer;
    try {
      data = target ? await target.locator.screenshot(options) : await tab.page.screenshot(options);
      outcome = 'ok';
    } finally {
      // Fork: lets a live test measure the capture (DEBUG=pw:mcp:shot), the failed ones included.
      shotDebug(`screenshot ${screenshotTargetLabel} background=${background} timeout=${options.timeout} took ${Math.round(monotonicTime() - startTime)}ms ${outcome}`);
    }

    const resolvedFile = await response.resolveClientOutputFile({ prefix: target ? 'element' : 'page', ext: fileType, suggestedFilename: params.filename }, `Screenshot of ${screenshotTargetLabel}`);

    response.addCode(`// Screenshot ${screenshotTargetLabel} and save it as ${resolvedFile.relativeName}`);
    if (target)
      response.addCode(`await page.${target.resolved}.screenshot(${formatObject({ ...options, path: resolvedFile.relativeName })});`);
    else
      response.addCode(`await page.screenshot(${formatObject({ ...options, path: resolvedFile.relativeName })});`);

    await response.addFileResult(resolvedFile, data);
    if (!params.filename)
      await response.registerImageResult(data, fileType);
  }
});

export default [
  screenshot,
];
