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

import * as vscode from 'vscode';
import type {ExtensionLogger} from './outputChannel';
import {
    GraphicalViewRenderResult,
    GraphicalViewRenderWarning,
    GraphicalViewRequestClient,
    GraphicalViewTarget,
    isGraphicalViewRenderResult,
} from './graphicalViewProtocol';

export const OPEN_GRAPHICAL_VIEW_COMMAND = 'turtle.openGraphicalView';

export type GraphicalViewStatus =
    | Readonly<{kind: 'loading'; message: string}>
    | Readonly<{kind: 'ready'; message: string}>
    | Readonly<{kind: 'stale'; reason: string; message: string}>
    | Readonly<{kind: 'unsupported'; message: string}>
    | Readonly<{kind: 'disconnected'; message: string}>;

export interface GraphicalViewAcceptedResult {
    readonly uri: string;
    readonly svg: string;
    readonly targets: readonly Readonly<GraphicalViewTarget>[];
    readonly warnings: readonly GraphicalViewRenderWarning[];
    readonly targetById: ReadonlyMap<string, Readonly<GraphicalViewTarget>>;
}

export type GraphicalViewDelivery =
    | Readonly<{type: 'status'; uri: string; status: GraphicalViewStatus}>
    | Readonly<{type: 'render'; uri: string; svg: string; warnings: readonly GraphicalViewRenderWarning[]}>;

export type GraphicalViewPanelMessage = Readonly<{type: 'ready'}> | Readonly<{type: 'refresh'}> | Readonly<{type: 'navigate'; targetId: string}>;

export interface GraphicalViewPanelAdapter extends vscode.Disposable {
    readonly visible: boolean;
    reveal(): void;
    deliver(delivery: GraphicalViewDelivery): void;
    onDidDispose(listener: () => void): vscode.Disposable;
    onDidChangeVisibility(listener: (visible: boolean) => void): vscode.Disposable;
    onDidReceiveMessage(listener: (message: unknown) => void): vscode.Disposable;
}

export interface GraphicalViewPanelFactory {
    create(sourceUri: string): GraphicalViewPanelAdapter;
}

export interface GraphicalViewDocument {
    readonly languageId: string;
    readonly uri: vscode.Uri;
}

export interface GraphicalViewWindow {
    readonly activeTextEditor: {readonly document: GraphicalViewDocument} | undefined;
    showWarningMessage(message: string): Thenable<unknown>;
}

export interface GraphicalViewWorkspace {
    onDidSaveTextDocument(listener: (document: GraphicalViewDocument) => void): vscode.Disposable;
    onDidChangeDocumentAvailability(listener: (sourceUri: string, available: boolean) => void): vscode.Disposable;
    isDocumentAvailable(uri: string): boolean;
}

export interface GraphicalViewCommands {
    registerCommand(command: string, callback: () => unknown): vscode.Disposable;
}

export interface GraphicalViewControllerContext {
    subscriptions: vscode.Disposable[];
}

export interface GraphicalViewPanelSnapshot {
    readonly sourceUri: string;
    readonly sequence: number;
    readonly visible: boolean;
    readonly disposed: boolean;
    readonly status: GraphicalViewStatus;
    readonly lastSuccess: GraphicalViewAcceptedResult | undefined;
}

interface PanelState {
    readonly sourceUri: string;
    readonly panel: GraphicalViewPanelAdapter;
    readonly subscriptions: vscode.Disposable[];
    sequence: number;
    sourceAvailable: boolean;
    visible: boolean;
    disposed: boolean;
    cancellation: vscode.CancellationTokenSource | undefined;
    status: GraphicalViewStatus;
    lastSuccess: GraphicalViewAcceptedResult | undefined;
}

const DISCONNECTED_STATUS: GraphicalViewStatus = Object.freeze({
    kind: 'disconnected',
    message: 'The Turtle language server is disconnected. Reconnect and use Refresh to try again.',
});

export class GraphicalViewController implements vscode.Disposable {
    private readonly panels = new Map<string, PanelState>();
    private readonly subscriptions: vscode.Disposable[] = [];
    private clientSubscription: vscode.Disposable | undefined;
    private registered = false;
    private disposed = false;

    constructor(
        private client: GraphicalViewRequestClient | undefined,
        private readonly panelFactory: GraphicalViewPanelFactory,
        private readonly commands: GraphicalViewCommands,
        private readonly window: GraphicalViewWindow,
        private readonly workspace: GraphicalViewWorkspace,
        private readonly outputChannel: ExtensionLogger,
        private readonly createCancellationSource: () => vscode.CancellationTokenSource = () => new vscode.CancellationTokenSource(),
    ) {
        this.subscribeToClient();
    }

    register(context: GraphicalViewControllerContext): void {
        if (this.registered || this.disposed) {
            return;
        }
        this.registered = true;

        this.subscriptions.push(
            this.commands.registerCommand(OPEN_GRAPHICAL_VIEW_COMMAND, () => this.openGraphicalView(this.window.activeTextEditor?.document)),
            this.workspace.onDidSaveTextDocument(document => this.handleSave(document)),
            this.workspace.onDidChangeDocumentAvailability((sourceUri, available) =>
                this.handleDocumentAvailability(sourceUri, available),
            ),
        );
        context.subscriptions.push(this);
    }

    async openGraphicalView(document: GraphicalViewDocument | undefined): Promise<GraphicalViewPanelSnapshot | undefined> {
        if (!document || document.languageId !== 'turtle') {
            await this.window.showWarningMessage('Open a Turtle file before opening the graphical view.');
            return undefined;
        }

        const sourceUri = document.uri.toString();
        const existing = this.panels.get(sourceUri);
        if (existing && !existing.disposed) {
            existing.panel.reveal();
            return this.snapshot(existing);
        }

        const panel = this.panelFactory.create(sourceUri);
        const state: PanelState = {
            sourceUri,
            panel,
            subscriptions: [],
            sequence: 0,
            sourceAvailable: this.workspace.isDocumentAvailable(sourceUri),
            visible: panel.visible,
            disposed: false,
            cancellation: undefined,
            status: Object.freeze({kind: 'loading', message: 'Preparing graphical view...'}),
            lastSuccess: undefined,
        };
        this.panels.set(sourceUri, state);
        state.subscriptions.push(
            panel.onDidDispose(() => this.disposePanelState(state, false)),
            panel.onDidChangeVisibility(visible => this.handleVisibilityChange(state, visible)),
            panel.onDidReceiveMessage(message => this.handlePanelMessage(state, message)),
        );
        void this.requestRender(state, 'initial');
        return this.snapshot(state);
    }

    setClient(client: GraphicalViewRequestClient | undefined): void {
        if (this.disposed) {
            return;
        }

        this.clientSubscription?.dispose();
        this.clientSubscription = undefined;
        this.client = client;
        for (const state of this.panels.values()) {
            this.invalidate(state);
            this.setStatus(state, client?.isGraphicalViewAvailable() ? availableAgainStatus(state) : DISCONNECTED_STATUS);
        }
        this.subscribeToClient();
    }

    getPanelCount(): number {
        return this.panels.size;
    }

    getPanelState(sourceUri: string): GraphicalViewPanelSnapshot | undefined {
        const state = this.panels.get(sourceUri);
        return state ? this.snapshot(state) : undefined;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.clientSubscription?.dispose();
        this.clientSubscription = undefined;
        for (const subscription of this.subscriptions.splice(0)) {
            subscription.dispose();
        }
        for (const state of [...this.panels.values()]) {
            this.disposePanelState(state, true);
        }
    }

    private subscribeToClient(): void {
        if (!this.client || this.disposed) {
            return;
        }
        this.clientSubscription = this.client.onDidChangeGraphicalViewAvailability(available => this.handleClientAvailability(available));
    }

    private handleClientAvailability(available: boolean): void {
        for (const state of this.panels.values()) {
            if (!available) {
                this.invalidate(state);
                this.setStatus(state, DISCONNECTED_STATUS);
            } else {
                this.setStatus(state, availableAgainStatus(state));
            }
        }
    }

    private handleSave(document: GraphicalViewDocument): void {
        const state = this.panels.get(document.uri.toString());
        if (!state || state.disposed) {
            return;
        }

        if (!state.visible) {
            this.invalidate(state);
            this.setStatus(state, retainedAfterHiddenSaveStatus(state));
            return;
        }

        void this.requestRender(state, 'save');
    }

    private handleDocumentAvailability(sourceUri: string, available: boolean): void {
        const state = this.panels.get(sourceUri);
        if (!state || state.disposed || state.sourceAvailable === available) {
            return;
        }

        state.sourceAvailable = available;
        if (available) {
            return;
        }

        this.invalidate(state);
        this.setStatus(state, retainedAfterSourceLossStatus(state));
    }

    private handleVisibilityChange(state: PanelState, visible: boolean): void {
        if (!this.isCurrent(state)) {
            return;
        }
        state.visible = visible;
        if (visible) {
            this.deliverCurrentState(state);
        }
    }

    private handlePanelMessage(state: PanelState, message: unknown): void {
        if (!this.isCurrent(state) || !isPanelMessage(message)) {
            return;
        }

        switch (message.type) {
            case 'ready':
                this.deliverCurrentState(state);
                return;
            case 'refresh':
                if (state.visible) {
                    void this.requestRender(state, 'manual');
                }
                return;
            case 'navigate':
                // Task 4 validates current-sidecar membership and resolves navigation.
                return;
        }
    }

    private async requestRender(state: PanelState, trigger: 'initial' | 'manual' | 'save'): Promise<void> {
        if (!this.isCurrent(state)) {
            return;
        }

        this.cancelCurrent(state);
        const sequence = ++state.sequence;
        const sourceUri = state.sourceUri;

        state.sourceAvailable = this.workspace.isDocumentAvailable(sourceUri);
        if (!state.sourceAvailable) {
            this.setStatus(
                state,
                Object.freeze({
                    kind: 'stale',
                    reason: 'sourceUnavailable',
                    message: 'The source document is not available to the language server. Reopen it and use Refresh.',
                }),
            );
            return;
        }

        const client = this.client;
        if (!client?.isGraphicalViewAvailable()) {
            this.setStatus(state, DISCONNECTED_STATUS);
            return;
        }

        const cancellation = this.createCancellationSource();
        state.cancellation = cancellation;
        this.setStatus(state, Object.freeze({kind: 'loading', message: `Rendering graphical view (${trigger})...`}));

        try {
            const result = await client.renderGraphicalView({uri: sourceUri}, cancellation.token);
            if (!this.isCurrentRequest(state, sourceUri, sequence, cancellation)) {
                return;
            }
            state.cancellation = undefined;
            cancellation.dispose();
            this.handleRenderResult(state, result);
        } catch (error) {
            if (!this.isCurrentRequest(state, sourceUri, sequence, cancellation)) {
                return;
            }
            state.cancellation = undefined;
            cancellation.dispose();
            this.handleRenderFailure(state, error);
        }
    }

    private handleRenderResult(state: PanelState, result: unknown): void {
        if (!isGraphicalViewRenderResult(result)) {
            this.setStale(state, 'invalidResponse', 'The language server returned an invalid graphical-view response.');
            return;
        }

        if (result.uri !== state.sourceUri) {
            this.setStale(state, 'uriMismatch', 'The language server returned a graphical view for a different source document.');
            return;
        }

        if (result.svg === undefined || result.svg === null) {
            this.handleWarningResult(state, result.warnings);
            return;
        }

        const accepted = createAcceptedResult(result, result.svg);
        state.lastSuccess = accepted;
        state.status = Object.freeze({kind: 'ready', message: 'Graphical view is up to date.'});
        state.panel.deliver(Object.freeze({type: 'render', uri: accepted.uri, svg: accepted.svg, warnings: accepted.warnings}));
        this.deliverStatus(state);
    }

    private handleWarningResult(state: PanelState, warnings: readonly GraphicalViewRenderWarning[]): void {
        const warning = warnings[0];
        switch (warning) {
            case 'timeout':
                this.setStale(state, warning, 'Graphical rendering timed out. The last successful diagram is retained.');
                return;
            case 'modelTooLarge':
                this.setStale(state, warning, 'The model is too large for graphical rendering. The last successful diagram is retained.');
                return;
            case 'missingDocument':
                this.setStale(state, warning, 'The source document is unavailable. The last successful diagram is retained.');
                return;
            case 'unsupportedUri':
                this.setStale(state, warning, 'The source URI is not supported for graphical rendering.');
                return;
            case 'temporarilyUnresolvable':
            default:
                this.setStale(state, warning ?? 'renderFailure', 'The model could not be loaded or parsed. The last successful diagram is retained.');
        }
    }

    private handleRenderFailure(state: PanelState, error: unknown): void {
        if (isMethodNotFound(error)) {
            this.setStatus(
                state,
                Object.freeze({
                    kind: 'unsupported',
                    message: 'Graphical view is not supported by the current server build. The last successful diagram is retained.',
                }),
            );
            return;
        }

        const detail = error instanceof Error ? error.message : String(error);
        this.setStale(state, classifyFailure(detail), `Graphical rendering failed: ${detail}. The last successful diagram is retained.`);
    }

    private setStale(state: PanelState, reason: string, message: string): void {
        this.setStatus(state, Object.freeze({kind: 'stale', reason, message}));
    }

    private setStatus(state: PanelState, status: GraphicalViewStatus): void {
        if (!this.isCurrent(state)) {
            return;
        }
        state.status = status;
        this.deliverStatus(state);
    }

    private deliverCurrentState(state: PanelState): void {
        this.deliverStatus(state);
        const accepted = state.lastSuccess;
        if (accepted) {
            state.panel.deliver(Object.freeze({type: 'render', uri: accepted.uri, svg: accepted.svg, warnings: accepted.warnings}));
        }
    }

    private deliverStatus(state: PanelState): void {
        state.panel.deliver(Object.freeze({type: 'status', uri: state.sourceUri, status: state.status}));
    }

    private invalidate(state: PanelState): void {
        if (!this.isCurrent(state)) {
            return;
        }
        this.cancelCurrent(state);
        state.sequence += 1;
    }

    private cancelCurrent(state: PanelState): void {
        const cancellation = state.cancellation;
        state.cancellation = undefined;
        if (cancellation) {
            cancellation.cancel();
            cancellation.dispose();
        }
    }

    private isCurrentRequest(
        state: PanelState,
        sourceUri: string,
        sequence: number,
        cancellation: vscode.CancellationTokenSource,
    ): boolean {
        return this.isCurrent(state) && state.sourceUri === sourceUri && state.sequence === sequence && state.cancellation === cancellation;
    }

    private isCurrent(state: PanelState): boolean {
        return !this.disposed && !state.disposed && this.panels.get(state.sourceUri) === state;
    }

    private disposePanelState(state: PanelState, disposePanel: boolean): void {
        if (state.disposed) {
            return;
        }
        this.cancelCurrent(state);
        state.sequence += 1;
        state.disposed = true;
        this.panels.delete(state.sourceUri);
        for (const subscription of state.subscriptions.splice(0)) {
            subscription.dispose();
        }
        if (disposePanel) {
            state.panel.dispose();
        }
    }

    private snapshot(state: PanelState): GraphicalViewPanelSnapshot {
        return Object.freeze({
            sourceUri: state.sourceUri,
            sequence: state.sequence,
            visible: state.visible,
            disposed: state.disposed,
            status: state.status,
            lastSuccess: state.lastSuccess,
        });
    }
}

function createAcceptedResult(result: GraphicalViewRenderResult, svg: string): GraphicalViewAcceptedResult {
    const targets = Object.freeze(result.targets.map(target => Object.freeze({...target})));
    const warnings = Object.freeze([...result.warnings]);
    const targetById = new ImmutableTargetMap(targets.map(target => [target.id, target]));
    return Object.freeze({uri: result.uri, svg, targets, warnings, targetById});
}

class ImmutableTargetMap<K, V> implements ReadonlyMap<K, V> {
    private readonly map: Map<K, V>;

    constructor(entries: readonly (readonly [K, V])[]) {
        this.map = new Map(entries);
        Object.freeze(this);
    }

    get size(): number {
        return this.map.size;
    }

    get(key: K): V | undefined {
        return this.map.get(key);
    }

    has(key: K): boolean {
        return this.map.has(key);
    }

    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
        this.map.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
    }

    entries(): MapIterator<[K, V]> {
        return this.map.entries();
    }

    keys(): MapIterator<K> {
        return this.map.keys();
    }

    values(): MapIterator<V> {
        return this.map.values();
    }

    [Symbol.iterator](): MapIterator<[K, V]> {
        return this.entries();
    }

    get [Symbol.toStringTag](): string {
        return 'ImmutableTargetMap';
    }
}

function availableAgainStatus(state: PanelState): GraphicalViewStatus {
    return Object.freeze({
        kind: 'stale',
        reason: 'clientAvailable',
        message: state.lastSuccess
            ? 'The language server is available again. The retained diagram remains visible; use Refresh to update it.'
            : 'The language server is available. Use Refresh to render the graphical view.',
    });
}

function retainedAfterHiddenSaveStatus(state: PanelState): GraphicalViewStatus {
    if (state.lastSuccess) {
        return Object.freeze({kind: 'ready', message: 'Showing the retained graphical-view snapshot.'});
    }
    return Object.freeze({
        kind: 'stale',
        reason: 'noSnapshot',
        message: 'No graphical-view snapshot is available. Reveal the panel and use Refresh to render one.',
    });
}

function retainedAfterSourceLossStatus(state: PanelState): GraphicalViewStatus {
    if (state.lastSuccess) {
        return Object.freeze({kind: 'ready', message: 'Showing the retained graphical-view snapshot.'});
    }
    return Object.freeze({
        kind: 'stale',
        reason: 'sourceUnavailable',
        message: 'The source document is no longer open. Reopen it and use Refresh to render the graphical view.',
    });
}

function isPanelMessage(value: unknown): value is GraphicalViewPanelMessage {
    if (!isRecord(value)) {
        return false;
    }
    const keys = Object.keys(value);
    if ((value.type === 'ready' || value.type === 'refresh') && keys.length === 1) {
        return true;
    }
    return value.type === 'navigate' && keys.length === 2 && typeof value.targetId === 'string';
}

function isMethodNotFound(error: unknown): boolean {
    if (isRecord(error) && error.code === -32601) {
        return true;
    }
    return error instanceof Error && /method\s+not\s+found/i.test(error.message);
}

function classifyFailure(message: string): string {
    if (/timeout|timed out/i.test(message)) {
        return 'timeout';
    }
    if (/parse|syntax/i.test(message)) {
        return 'parse';
    }
    if (/load/i.test(message)) {
        return 'loading';
    }
    if (/transport|connection|socket/i.test(message)) {
        return 'transport';
    }
    return 'error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
