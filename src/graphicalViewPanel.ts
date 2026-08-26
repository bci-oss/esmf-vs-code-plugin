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

export class VscodeGraphicalViewPanelFactory implements GraphicalViewPanelFactory {
    create(sourceUri: string): GraphicalViewPanelAdapter {
        const uri = vscode.Uri.parse(sourceUri, true);
        const name = uri.path.split('/').filter(Boolean).at(-1) ?? 'Aspect Model';
        const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `Graphical View: ${name}`, vscode.ViewColumn.Beside, {
            enableScripts: true,
            enableForms: false,
            enableCommandUris: false,
            localResourceRoots: [],
        });
        return new VscodeGraphicalViewPanel(panel);
    }
}

class VscodeGraphicalViewPanel implements GraphicalViewPanelAdapter {
    constructor(private readonly panel: vscode.WebviewPanel) {
        panel.webview.html = createShellHtml(panel.webview);
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

function createShellHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; img-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Graphical View</title>
</head>
<body>
    <button id="refresh" type="button">Refresh</button>
    <p id="status" role="status">Preparing graphical view...</p>
    <p id="task4-boundary">Diagram rendering is prepared. Secure SVG display is completed in Task 4.</p>
    <script nonce="${nonce}">
        (() => {
            const vscode = acquireVsCodeApi();
            const status = document.getElementById('status');
            document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({type: 'refresh'}));
            window.addEventListener('message', event => {
                const message = event.data;
                if (message && message.type === 'status' && message.status && typeof message.status.message === 'string') {
                    status.textContent = message.status.message;
                }
                if (message && message.type === 'render') {
                    document.body.dataset.snapshotAvailable = 'true';
                }
            });
            vscode.postMessage({type: 'ready'});
        })();
    </script>
</body>
</html>`;
}
