/*
 * Copyright (c) 2026 Robert Bosch Manufacturing Solutions GmbH
 * SPDX-License-Identifier: MPL-2.0
 */

import * as assert from 'node:assert/strict';
import {join} from 'node:path';
import * as vscode from 'vscode';
import {createGraphicalViewPanelOptions, createGraphicalViewShell} from '../graphicalViewPanel';

const HEADER_MARKER = 'gv-header-aaaaaaaaaaaaaaaa';
const GERMAN_MARKER = 'gv-attribute-bbbbbbbbbbbbbbbb';
const ENGLISH_MARKER = 'gv-attribute-eeeeeeeeeeeeeeee';

suite('GraphicalView real webview lifecycle', function () {
    this.timeout(30_000);

    test('securely renders and rehydrates the stable shell after real context recreation', async function (this: Mocha.Context) {
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
        const shell = createGraphicalViewShell(panel.webview, extensionUri);

        try {
            panel.webview.html = shell;
            await waitFor(() => countMessages(messages, 'ready') >= 1, 'initial ready');
            assert.equal(await panel.webview.postMessage({type: 'render', version: 1, svg: graphperSvg(HEADER_MARKER)}), true);
            await waitFor(() => hasMessage(messages, 'rendered', 1), 'initial secure render');
            assert.equal(hasMessage(messages, 'renderError', 1), false);

            const hiddenDocument = await vscode.workspace.openTextDocument({content: 'Hide graphical view', language: 'plaintext'});
            await vscode.window.showTextDocument(hiddenDocument, {viewColumn: vscode.ViewColumn.One, preview: false});
            await waitFor(() => !panel.visible, 'webview becoming hidden');
            const rendersBeforeReveal = countMessages(messages, 'rendered');

            panel.reveal(vscode.ViewColumn.One, false);
            await waitFor(() => countMessages(messages, 'ready') >= 2, 'recreated webview ready');
            assert.equal(countMessages(messages, 'rendered'), rendersBeforeReveal, 'reveal must not render by itself');
            assert.equal(panel.webview.html, shell, 'stable shell must not be reassigned per result');

            await panel.webview.postMessage({type: 'render', version: 1, svg: graphperSvg(HEADER_MARKER)});
            await waitFor(() => countMessages(messages, 'rendered') >= 2, 'retained result rehydration');
            await panel.webview.postMessage({
                type: 'render',
                version: 2,
                svg: multilingualSvg(GERMAN_MARKER, ENGLISH_MARKER),
            });
            await waitFor(() => hasMessage(messages, 'rendered', 2), 'multilingual replacement render');
            assert.equal(messages.some(message => isRecord(message) && message.type === 'renderError'), false);

            await panel.webview.postMessage({type: 'render', version: 3, svg: '<svg><script>alert(1)</script></svg>'});
            await waitFor(() => hasMessage(messages, 'renderError', 3), 'fail-closed hostile render');
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

function multilingualSvg(germanMarker: string, englishMarker: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" height="1600pt" width="2200pt" viewBox="0 0 2200 1600">
<g id="graph_root" class="graph" transform="scale(1 1) rotate(0)">
<g id="${germanMarker}" class="node"><polygon points="10,10 2190,10 2190,700 10,700"></polygon><text x="20" y="300">description [de]: Beschreibung</text></g>
<g id="${englishMarker}" class="node"><polygon points="10,710 2190,710 2190,1590 10,1590"></polygon><text x="20" y="1000">description [en]: Description</text></g>
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

function countMessages(messages: readonly unknown[], type: string): number {
    return messages.filter(message => isRecord(message) && message.type === type).length;
}

function hasMessage(messages: readonly unknown[], type: string, version: number): boolean {
    return messages.some(message => isRecord(message) && message.type === type && message.version === version);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
