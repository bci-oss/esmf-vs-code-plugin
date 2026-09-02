/*
 * Copyright (c) 2026 Robert Bosch Manufacturing Solutions GmbH
 * SPDX-License-Identifier: MPL-2.0
 */

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const outputDirectory = resolve(extensionRoot, 'out', 'webview');

export const webviewAssets = Object.freeze([
    asset('node_modules/dompurify/LICENSE', 'DOMPurify-LICENSE-Apache-2.0.txt'),
    asset('node_modules/dompurify/LICENSE-MPL', 'DOMPurify-LICENSE-MPL-2.0.txt'),
    asset(
        'node_modules/dompurify/dist/purify.min.js',
        'purify.min.js',
        '9ab3d44d73c3e3947f9ab72e0f0bc15c7f1931d60b365ba261fc85fe59013c56',
    ),
    asset('src/webview/RobotoCondensed-NOTICE.txt', 'RobotoCondensed-NOTICE.txt'),
    asset(
        'src/webview/RobotoCondensed-Regular.ttf',
        'RobotoCondensed-Regular.ttf',
        '4a7c36df4318fee50a8159c3a0ebde4572abab65447ae4a651c2fe87212302b5',
    ),
    asset('src/webview/sanitizer-contract.js', 'sanitizer-contract.js'),
    asset('src/webview/webview.css', 'webview.css'),
    asset('src/webview/webview.js', 'webview.js'),
]);

export function sha256(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function asset(source, destination, expectedSha256) {
    return Object.freeze({
        source: resolve(extensionRoot, source),
        destination,
        ...(expectedSha256 ? {expectedSha256} : {}),
    });
}
