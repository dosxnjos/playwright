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

/**
 * Merge config passed to `merge-reports` via `-c` (see cli.ts).
 *
 * Blob reports from different runners record different absolute `testDir`s
 * (Linux `/home/runner/...`, macOS `/Users/runner/...`, Windows `D:\a\...`).
 * Without a merge config, `merge-reports` refuses to merge reports whose
 * `testDir`s disagree. Providing any config supplies a single canonical
 * `rootDir` and lets the merge proceed; `testDir` points at the repo's real
 * tests directory (resolved relative to this file: `<repoRoot>/tests`).
 */
export default {
  testDir: '../../../tests',
};
