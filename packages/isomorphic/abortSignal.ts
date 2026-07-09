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

export function assertionAbortedMessage(reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : reason === undefined || reason === null ? '' : String(reason);
  return 'The assertion was aborted' + (detail ? `: ${detail}` : '');
}

export function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a)
    return b;
  if (!b)
    return a;
  if (a.aborted)
    return a;
  if (b.aborted)
    return b;

  const controller = new AbortController();
  const onA = () => onAbort(a);
  const onB = () => onAbort(b);
  const onAbort = (source: AbortSignal) => {
    controller.abort(source.reason);
    a.removeEventListener('abort', onA);
    b.removeEventListener('abort', onB);
  };
  a.addEventListener('abort', onA, { once: true });
  b.addEventListener('abort', onB, { once: true });
  return controller.signal;
}

export class TestEndedError extends Error {}
