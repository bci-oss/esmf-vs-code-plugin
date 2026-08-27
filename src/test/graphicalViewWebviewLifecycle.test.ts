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
import {join} from 'node:path';
import * as vscode from 'vscode';
import {createGraphicalViewPanelOptions, createShellHtml} from '../graphicalViewPanel';

const FIRST_MARKER = 'gv-header-aaaaaaaaaaaaaaaa';
const SECOND_MARKER = 'gv-attribute-bbbbbbbbbbbbbbbb';
const WRAPPED_SEE_FIRST_MARKER = 'gv-attribute-cccccccccccccccc';
const WRAPPED_SEE_CONTINUATION_MARKER = 'gv-attribute-dddddddddddddddd';

suite('GraphicalView real webview lifecycle', function () {
    this.timeout(30_000);

    test('rehydrates viewport state and keeps current/stale clicks bounded across context recreation', async function (this: Mocha.Context) {
        this.timeout(30_000);
        const extensionUri = vscode.Uri.file(join(__dirname, '..', '..'));
        const panel = vscode.window.createWebviewPanel(
            'turtle.graphicalViewLifecycleTest',
            'Graphical View Lifecycle Test',
            vscode.ViewColumn.One,
            createGraphicalViewPanelOptions(extensionUri),
        );
        const messages: unknown[] = [];
        const subscription = panel.webview.onDidReceiveMessage(message => messages.push(message));
        const shell = createShellHtml(panel.webview, extensionUri, 'lifecycle-test-nonce', true);

        try {
            panel.webview.html = shell;
            await waitFor(() => countMessages(messages, 'ready') >= 1, 'initial ready');
            panel.reveal(vscode.ViewColumn.One, false);
            await waitFor(() => panel.visible, 'initial webview visibility');
            await new Promise(resolve => setTimeout(resolve, 100));

            assert.equal(
                await panel.webview.postMessage({type: 'render', version: 1, svg: graphperSvg(FIRST_MARKER)}),
                true,
                `initial render delivery failed; messages=${JSON.stringify(messages)}`,
            );
            await waitFor(
                () => hasMessage(messages, 'rendered', 1) || hasMessage(messages, 'renderError', 1),
                'initial secure render',
                3_000,
            ).catch(error => {
                throw new Error(`${error instanceof Error ? error.message : String(error)}; messages=${JSON.stringify(messages)}`);
            });
            assert.equal(
                hasMessage(messages, 'renderError', 1),
                false,
                `secure render failed: ${JSON.stringify(messages.filter(message => isRecord(message) && message.type === 'testRenderDiagnostic'))}`,
            );

            await panel.webview.postMessage({type: 'testSetViewport', zoom: 1.5, scrollLeft: 280, scrollTop: 190});
            const firstState = await waitForMessage(messages, message => isViewportState(message, 1.5, 280, 190), 'viewport persistence');
            assert.deepEqual(firstState.state, {schemaVersion: 1, zoom: 1.5, scrollLeft: 280, scrollTop: 190});

            const hiddenDocument = await vscode.workspace.openTextDocument({
                content: 'Hide graphical view lifecycle test',
                language: 'plaintext',
            });
            await vscode.window.showTextDocument(hiddenDocument, {viewColumn: vscode.ViewColumn.One, preview: false});
            await waitFor(() => !panel.visible, 'webview becoming hidden');
            const renderedBeforeReveal = countMessages(messages, 'rendered');

            panel.reveal(vscode.ViewColumn.One, false);
            await waitFor(() => countMessages(messages, 'ready') >= 2, 'recreated webview ready');
            assert.equal(countMessages(messages, 'rendered'), renderedBeforeReveal, 'reveal must not render by itself');
            assert.equal(panel.webview.html, shell, 'stable shell must not be reassigned per result');

            await panel.webview.postMessage({type: 'render', version: 1, svg: graphperSvg(FIRST_MARKER)});
            await waitFor(() => countMessages(messages, 'rendered') >= 2, 'retained result rehydration');
            const restoredState = await waitForMessage(
                messages,
                message => isViewportState(message, 1.5, 280, 190),
                'restored viewport state',
                1,
            ).catch(error => {
                throw new Error(`${error instanceof Error ? error.message : String(error)}; messages=${JSON.stringify(messages)}`);
            });
            assert.equal(restoredState.state.schemaVersion, 1);

            await panel.webview.postMessage({type: 'testClickMarker', targetId: FIRST_MARKER});
            await waitFor(() => navigationMessages(messages).length === 1, 'current marker click');
            assert.deepEqual(navigationMessages(messages)[0], {type: 'navigate', version: 1, targetId: FIRST_MARKER});

            await panel.webview.postMessage({type: 'render', version: 2, svg: graphperSvg(SECOND_MARKER)});
            await waitFor(() => hasMessage(messages, 'rendered', 2), 'replacement render');
            await panel.webview.postMessage({type: 'testClickMarker', targetId: FIRST_MARKER});
            await new Promise(resolve => setTimeout(resolve, 200));
            assert.equal(navigationMessages(messages).length, 1, 'stale marker must be inert after replacement');

            await panel.webview.postMessage({type: 'testClickMarker', targetId: SECOND_MARKER});
            await waitFor(() => navigationMessages(messages).length === 2, 'replacement marker click');
            assert.deepEqual(navigationMessages(messages)[1], {type: 'navigate', version: 2, targetId: SECOND_MARKER});
            await panel.webview.postMessage({type: 'testKeyMarker', targetId: SECOND_MARKER, key: 'Enter'});
            await waitFor(() => navigationMessages(messages).length === 3, 'attribute marker Enter activation');
            await panel.webview.postMessage({type: 'testKeyMarker', targetId: SECOND_MARKER, key: ' '});
            await waitFor(() => navigationMessages(messages).length === 4, 'attribute marker Space activation');
            assert.deepEqual(navigationMessages(messages).slice(2), [
                {type: 'navigate', version: 2, targetId: SECOND_MARKER},
                {type: 'navigate', version: 2, targetId: SECOND_MARKER},
            ]);

            await panel.webview.postMessage({
                type: 'render',
                version: 3,
                svg: wrappedSeeSvg(WRAPPED_SEE_FIRST_MARKER, WRAPPED_SEE_CONTINUATION_MARKER),
            });
            await waitFor(() => hasMessage(messages, 'rendered', 3), 'wrapped see render');
            await panel.webview.postMessage({type: 'testClickMarker', targetId: WRAPPED_SEE_FIRST_MARKER});
            await waitFor(() => navigationMessages(messages).length === 5, 'wrapped see first-row click');
            await panel.webview.postMessage({type: 'testClickMarker', targetId: WRAPPED_SEE_CONTINUATION_MARKER});
            await waitFor(() => navigationMessages(messages).length === 6, 'wrapped see continuation-row click');
            assert.deepEqual(navigationMessages(messages).slice(4), [
                {type: 'navigate', version: 3, targetId: WRAPPED_SEE_FIRST_MARKER},
                {type: 'navigate', version: 3, targetId: WRAPPED_SEE_CONTINUATION_MARKER},
            ]);
            assert.equal(
                messages.some(message => isRecord(message) && message.type === 'renderError'),
                false,
            );
        } finally {
            subscription.dispose();
            panel.dispose();
        }
    });
});

function graphperSvg(marker: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" height="1600pt" width="2200pt" viewBox="0 0 2200 1600">
<style>@font-face { font-family: Roboto Condensed; }</style>
<g id="graph_root" class="graph" transform="scale(1 1) rotate(0)">
<g id="${marker}" class="node">
<polygon id="${marker}_polygon" points="10,10 2190,10 2190,1590 10,1590" fill="#ffffff" stroke="#000000" stroke-width="1" cx="0" cy="0" rx="0" ry="0"></polygon>
<text id="${marker}_text_0" x="1100" y="800" fill="#000000" font-family="Arial" font-size="12" text-anchor="middle">Aspect</text>
<title>Aspect</title>
</g>
</g>
</svg>`;
}

function wrappedSeeSvg(firstMarker: string, continuationMarker: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" height="1600pt" width="2200pt" viewBox="0 0 2200 1600">
<g id="graph_root" class="graph" transform="scale(1 1) rotate(0)">
<g id="${firstMarker}" class="node"><polygon points="10,10 2190,10 2190,700 10,700"></polygon><text x="20" y="300">see: urn:irdi:0173:1:02:AAO677:002,</text></g>
<g id="${continuationMarker}" class="node"><polygon points="10,710 2190,710 2190,1590 10,1590"></polygon><text x="20" y="1000">urn:irdi:0173:1:02:AAO677:003</text></g>
</g>
</svg>`;
}

async function waitFor(probe: () => boolean, description: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (probe()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${description}`);
}

async function waitForMessage<T>(
    messages: readonly unknown[],
    predicate: (message: unknown) => message is T,
    description: string,
    skip = 0,
): Promise<T> {
    let result: T | undefined;
    await waitFor(() => {
        const matches = messages.filter(predicate);
        result = matches.at(skip);
        return result !== undefined;
    }, description);
    return result as T;
}

function countMessages(messages: readonly unknown[], type: string): number {
    return messages.filter(message => isRecord(message) && message.type === type).length;
}

function hasMessage(messages: readonly unknown[], type: string, version: number): boolean {
    return messages.some(message => isRecord(message) && message.type === type && message.version === version);
}

function navigationMessages(messages: readonly unknown[]): unknown[] {
    return messages.filter(message => isRecord(message) && message.type === 'navigate');
}

function isTestState(
    message: unknown,
): message is {type: 'testState'; state: {schemaVersion: number; zoom: number; scrollLeft: number; scrollTop: number}} {
    return (
        isRecord(message) &&
        message.type === 'testState' &&
        isRecord(message.state) &&
        typeof message.state.schemaVersion === 'number' &&
        typeof message.state.zoom === 'number' &&
        typeof message.state.scrollLeft === 'number' &&
        typeof message.state.scrollTop === 'number'
    );
}

function isViewportState(
    message: unknown,
    zoom: number,
    scrollLeft: number,
    scrollTop: number,
): message is {type: 'testState'; state: {schemaVersion: number; zoom: number; scrollLeft: number; scrollTop: number}} {
    return (
        isTestState(message) &&
        message.state.zoom === zoom &&
        message.state.scrollLeft === scrollLeft &&
        message.state.scrollTop === scrollTop
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
