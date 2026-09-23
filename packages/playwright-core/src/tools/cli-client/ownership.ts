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

export type SessionLiveness = 'none' | 'open' | 'unresponsive' | 'stale';
export type SessionOperation = 'open' | 'attach' | 'use' | 'close-all' | 'list-gc' | 'kill-all' | 'attach-target';
export type SessionPolicyAction =
  'create' |
  'restart' |
  'clear-and-create' |
  'allow' |
  'not-found' |
  'skip' |
  'keep' |
  'remove' |
  'refuse-owner' |
  'refuse-unresponsive' |
  'refuse-kill-all';

export function sessionOwnershipPolicy(
  callerOwner: string | undefined,
  entryOwner: string | undefined,
  liveness: SessionLiveness,
  operation: SessionOperation
): SessionPolicyAction {
  const sameOwner = callerOwner === entryOwner;

  if (operation === 'kill-all')
    return callerOwner === undefined ? 'allow' : 'refuse-kill-all';

  if (operation === 'attach-target') {
    if (callerOwner === undefined || liveness === 'none' || sameOwner)
      return 'allow';
    return 'refuse-owner';
  }

  if (operation === 'list-gc')
    return liveness === 'stale' && sameOwner ? 'remove' : 'keep';

  if (operation === 'close-all')
    return sameOwner ? 'allow' : 'skip';

  if (operation === 'use') {
    if (liveness === 'none')
      return 'not-found';
    return sameOwner ? 'allow' : 'refuse-owner';
  }

  if (liveness === 'none')
    return 'create';
  if (liveness === 'unresponsive') {
    if (sameOwner && callerOwner === undefined)
      return 'clear-and-create';
    return 'refuse-unresponsive';
  }
  if (!sameOwner)
    return 'refuse-owner';
  return liveness === 'open' ? 'restart' : 'clear-and-create';
}
