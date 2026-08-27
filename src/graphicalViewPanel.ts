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

import {randomBytes} from 'node:crypto';
import * as vscode from 'vscode';
import {GraphicalViewDelivery, GraphicalViewPanelAdapter, GraphicalViewPanelFactory} from './graphicalView';

const VIEW_TYPE = 'turtle.graphicalView';
export const WEBVIEW_ASSET_DIRECTORY = Object.freeze(['out', 'webview'] as const);
export const WEBVIEW_SCRIPT_ORDER = Object.freeze(['purify.min.js', 'sanitizer-contract.js', 'webview.js'] as const);

export class VscodeGraphicalViewPanelFactory implements GraphicalViewPanelFactory {
    constructor(private readonly extensionUri: vscode.Uri) {}

    create(sourceUri: string): GraphicalViewPanelAdapter {
        const uri = vscode.Uri.parse(sourceUri, true);
        const name = uri.path.split('/').filter(Boolean).at(-1) ?? 'Aspect Model';
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            `Graphical View: ${name}`,
            vscode.ViewColumn.Beside,
            createGraphicalViewPanelOptions(this.extensionUri),
        );
        return new VscodeGraphicalViewPanel(panel, this.extensionUri);
    }
}

class VscodeGraphicalViewPanel implements GraphicalViewPanelAdapter {
    constructor(
        private readonly panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
    ) {
        panel.webview.html = createShellHtml(panel.webview, extensionUri);
    }

    get visible(): boolean {
        return this.panel.visible;
    }

    reveal(): void {
        this.panel.reveal(undefined, false);
    }

    deliver(delivery: GraphicalViewDelivery): void {
        void this.panel.webview.postMessage(delivery);
    }

    onDidDispose(listener: () => void): vscode.Disposable {
        return this.panel.onDidDispose(listener);
    }

    onDidChangeVisibility(listener: (visible: boolean) => void): vscode.Disposable {
        return this.panel.onDidChangeViewState(event => listener(event.webviewPanel.visible));
    }

    onDidReceiveMessage(listener: (message: unknown) => void): vscode.Disposable {
        return this.panel.webview.onDidReceiveMessage(listener);
    }

    dispose(): void {
        this.panel.dispose();
    }
}

export function webviewAssetDirectory(extensionUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(extensionUri, ...WEBVIEW_ASSET_DIRECTORY);
}

export function createGraphicalViewPanelOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: false,
        localResourceRoots: [webviewAssetDirectory(extensionUri)],
    };
}

export function createShellHtml(
    webview: Pick<vscode.Webview, 'asWebviewUri' | 'cspSource'>,
    extensionUri: vscode.Uri,
    nonce = randomBytes(18).toString('base64'),
    testMode = false,
): string {
    const assetDirectory = webviewAssetDirectory(extensionUri);
    const stylesheetUri = webview.asWebviewUri(vscode.Uri.joinPath(assetDirectory, 'webview.css'));
    const scriptUris = WEBVIEW_SCRIPT_ORDER.map(asset => webview.asWebviewUri(vscode.Uri.joinPath(assetDirectory, asset)));
    const csp = [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src ${webview.cspSource}`,
        `font-src ${webview.cspSource}`,
        "img-src 'none'",
        "connect-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en"${testMode ? ' data-test-mode="true"' : ''}>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${stylesheetUri}">
    <title>Graphical View</title>
</head>
<body>
    <div id="toolbar" role="toolbar" aria-label="Graphical view controls">
        <button id="refresh" type="button" aria-label="Refresh graphical view" title="Refresh">Refresh</button>
        <button id="zoom-out" type="button" aria-label="Zoom out" title="Zoom out">−</button>
        <output id="zoom-value" aria-live="polite">100%</output>
        <button id="zoom-in" type="button" aria-label="Zoom in" title="Zoom in">+</button>
        <button id="zoom-reset" type="button" aria-label="Reset zoom to 100 percent" title="Reset zoom">100%</button>
        <button id="zoom-fit" type="button" aria-label="Fit diagram to view" title="Fit to view">Fit</button>
        <p id="status" role="status">Preparing graphical view...</p>
    </div>
    <main id="viewport" tabindex="0" aria-label="Scrollable graphical view">
        <div id="diagram" aria-live="off"></div>
    </main>
    <script nonce="${nonce}" src="${scriptUris[0]}"></script>
    <script nonce="${nonce}" src="${scriptUris[1]}"></script>
    <script nonce="${nonce}" src="${scriptUris[2]}"></script>
</body>
</html>`;
}
