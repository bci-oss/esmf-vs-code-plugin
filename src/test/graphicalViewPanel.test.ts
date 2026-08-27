/*
 * Copyright (c) 2026 Robert Bosch Manufacturing Solutions GmbH
 *
 * See the AUTHORS file(s) distributed with this work for additional
 * information regarding authorship.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import * as assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import * as vscode from 'vscode';
import {WEBVIEW_SCRIPT_ORDER, createGraphicalViewPanelOptions, createShellHtml, webviewAssetDirectory} from '../graphicalViewPanel';

suite('GraphicalView secure panel contract', () => {
    test('uses exact script/forms/command options and one out/webview resource root without retention', () => {
        const extensionUri = vscode.Uri.file('/tmp/graphical-view-extension');
        const options = createGraphicalViewPanelOptions(extensionUri);

        assert.equal(options.enableScripts, true);
        assert.equal(options.enableForms, false);
        assert.equal(options.enableCommandUris, false);
        assert.equal(options.localResourceRoots?.length, 1);
        assert.equal(options.localResourceRoots?.[0].toString(), webviewAssetDirectory(extensionUri).toString());
        assert.equal('retainContextWhenHidden' in options, false);
    });

    test('creates the exact CSP, fresh nonce, local resource URIs, and fixed external script order', () => {
        const extensionUri = vscode.Uri.file('/tmp/graphical-view-extension');
        const webview = {
            cspSource: 'vscode-webview-resource:',
            asWebviewUri: (uri: vscode.Uri) => uri.with({scheme: 'vscode-webview-resource'}),
        };
        const first = createShellHtml(webview, extensionUri, 'first-nonce');
        const second = createShellHtml(webview, extensionUri, 'second-nonce');

        const expectedCsp =
            "default-src 'none'; script-src 'nonce-first-nonce'; style-src vscode-webview-resource:; " +
            "font-src vscode-webview-resource:; img-src 'none'; connect-src 'none'; object-src 'none'; " +
            "base-uri 'none'; form-action 'none'";
        assert.ok(first.includes(`content="${expectedCsp}"`));
        assert.equal(first.includes('second-nonce'), false);
        assert.equal(second.includes('second-nonce'), true);
        assert.equal((first.match(/<script /g) ?? []).length, 3);
        assert.equal((first.match(/nonce="first-nonce"/g) ?? []).length, 3);
        assert.equal(first.includes('<script nonce="first-nonce">'), false);
        assert.equal(first.includes('http://'), false);
        assert.equal(first.includes('https://'), false);

        const scriptPositions = WEBVIEW_SCRIPT_ORDER.map(asset => first.indexOf(`/out/webview/${asset}`));
        assert.ok(scriptPositions.every(position => position >= 0));
        assert.deepEqual(
            [...scriptPositions].sort((left, right) => left - right),
            scriptPositions,
        );
        assert.ok(first.includes('/out/webview/webview.css'));
    });

    test('build output contains only the deterministic webview inventory and reference hashes', () => {
        const outputDirectory = join(__dirname, '..', 'webview');
        const expectedFiles = [
            'DOMPurify-LICENSE-Apache-2.0.txt',
            'DOMPurify-LICENSE-MPL-2.0.txt',
            'RobotoCondensed-NOTICE.txt',
            'RobotoCondensed-Regular.ttf',
            'purify.min.js',
            'sanitizer-contract.js',
            'webview.css',
            'webview.js',
        ];
        assert.deepEqual(readdirSync(outputDirectory).sort(), expectedFiles);
        assert.equal(sha256(join(outputDirectory, 'purify.min.js')), '9ab3d44d73c3e3947f9ab72e0f0bc15c7f1931d60b365ba261fc85fe59013c56');
        assert.equal(
            sha256(join(outputDirectory, 'RobotoCondensed-Regular.ttf')),
            '4a7c36df4318fee50a8159c3a0ebde4572abab65447ae4a651c2fe87212302b5',
        );
    });

    test('webview controller retains a stable DOM sink and persists passive viewport state only', () => {
        const controllerSource = readFileSync(join(__dirname, '..', '..', 'src', 'webview', 'webview.js'), 'utf8');
        assert.ok(controllerSource.includes('diagram.replaceChildren(sanitized.fragment)'));
        assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(controllerSource), false);
        assert.ok(controllerSource.includes('vscode.getState()'));
        assert.ok(controllerSource.includes('vscode.setState(state)'));
        assert.ok(controllerSource.includes('schemaVersion: 1'));
        assert.ok(controllerSource.includes('scrollLeft'));
        assert.ok(controllerSource.includes('scrollTop'));
        assert.equal(/setState\([^)]*(?:svg|uri|target|command)/i.test(controllerSource), false);
    });
});

function sha256(file: string): string {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}
