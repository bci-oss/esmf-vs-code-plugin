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
    GRAPHICAL_VIEW_MARKER_PATTERN,
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
    readonly version: number;
    readonly uri: string;
    readonly svg: string;
    readonly targets: readonly Readonly<GraphicalViewTarget>[];
    readonly warnings: readonly GraphicalViewRenderWarning[];
    readonly targetById: ReadonlyMap<string, Readonly<GraphicalViewTarget>>;
}

export type GraphicalViewDelivery =
    | Readonly<{type: 'status'; status: GraphicalViewStatus}>
    | Readonly<{type: 'render'; version: number; svg: string}>;

export type GraphicalViewPanelMessage =
    | Readonly<{type: 'ready'}>
    | Readonly<{type: 'refresh'}>
    | Readonly<{type: 'rendered'; version: number}>
    | Readonly<{type: 'renderError'; version: number; reason: 'sanitizationFailed'}>
    | Readonly<{type: 'navigate'; version: number; targetId: string}>;

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
    showTextDocument(uri: vscode.Uri, options?: vscode.TextDocumentShowOptions): Thenable<vscode.TextEditor>;
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
    navigationCancellation: vscode.CancellationTokenSource | undefined;
    nextDisplayVersion: number;
    status: GraphicalViewStatus;
    lastSuccess: GraphicalViewAcceptedResult | undefined;
    pendingDelivery: PendingDelivery | undefined;
}

interface PendingDelivery {
    readonly accepted: GraphicalViewAcceptedResult;
    readonly requestSequence: number;
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
            navigationCancellation: undefined,
            nextDisplayVersion: 0,
            status: Object.freeze({kind: 'loading', message: 'Preparing graphical view...'}),
            lastSuccess: undefined,
            pendingDelivery: undefined,
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
            this.deliverStatus(state);
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
            case 'rendered':
                this.handleRendered(state, message.version);
                return;
            case 'renderError':
                this.handleRenderError(state, message.version);
                return;
            case 'navigate':
                void this.navigateToTarget(state, message);
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
            this.handleRenderResult(state, result, sequence);
        } catch (error) {
            if (!this.isCurrentRequest(state, sourceUri, sequence, cancellation)) {
                return;
            }
            state.cancellation = undefined;
            cancellation.dispose();
            this.handleRenderFailure(state, error);
        }
    }

    private handleRenderResult(state: PanelState, result: unknown, requestSequence: number): void {
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

        const accepted = createAcceptedResult(result, result.svg, ++state.nextDisplayVersion);
        state.pendingDelivery = Object.freeze({accepted, requestSequence});
        state.panel.deliver(Object.freeze({type: 'render', version: accepted.version, svg: accepted.svg}));
    }

    private handleRendered(state: PanelState, version: number): void {
        const pending = state.pendingDelivery;
        if (pending?.accepted.version === version) {
            this.cancelNavigation(state);
            state.lastSuccess = pending.accepted;
            state.pendingDelivery = undefined;
            if (state.sequence === pending.requestSequence) {
                this.setStatus(state, Object.freeze({kind: 'ready', message: 'Graphical view is up to date.'}));
            }
            return;
        }

        // An acknowledgement for a rehydrated last-successful snapshot must not
        // clear a newer stale/error status.
    }

    private handleRenderError(state: PanelState, version: number): void {
        if (state.pendingDelivery?.accepted.version === version) {
            state.pendingDelivery = undefined;
        } else if (state.lastSuccess?.version !== version) {
            return;
        }
        this.outputChannel.warn('Graphical view rejected an SVG payload at the secure rendering boundary.');
        this.setStale(
            state,
            'sanitizationFailed',
            'The new diagram could not be displayed safely. The last successful diagram is retained.',
        );
    }

    private async navigateToTarget(
        state: PanelState,
        message: Readonly<{type: 'navigate'; version: number; targetId: string}>,
    ): Promise<void> {
        const accepted = state.lastSuccess;
        const target = accepted?.version === message.version ? accepted.targetById.get(message.targetId) : undefined;
        if (!accepted || !target || target.kind !== 'elementHeader' || !GRAPHICAL_VIEW_MARKER_PATTERN.test(message.targetId)) {
            return;
        }

        const client = this.client;
        if (!client?.isGraphicalViewAvailable()) {
            await this.warnNavigation('The graphical target is temporarily unavailable because the language server is disconnected.');
            return;
        }

        this.cancelNavigation(state);
        const cancellation = this.createCancellationSource();
        state.navigationCancellation = cancellation;
        try {
            const response = await client.resolveGraphicalViewTarget(
                {sourceUri: state.sourceUri, elementUrn: target.elementUrn},
                cancellation.token,
            );
            if (!this.isCurrentNavigation(state, accepted, target, cancellation)) {
                return;
            }
            state.navigationCancellation = undefined;
            cancellation.dispose();

            const resolved = validateResolveTargetResult(response);
            if (resolved.kind === 'warning') {
                await this.warnNavigation(resolveWarningMessage(resolved.warning));
                return;
            }
            if (resolved.kind === 'invalid') {
                await this.warnNavigation('The language server returned an invalid graphical target location.');
                return;
            }

            try {
                const editor = await this.window.showTextDocument(resolved.uri, {preview: false});
                if (!this.isCurrentNavigationResult(state, accepted, target)) {
                    return;
                }
                const range = new vscode.Range(
                    resolved.start.line,
                    resolved.start.character,
                    resolved.end.line,
                    resolved.end.character,
                );
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            } catch (_error) {
                await this.warnNavigation('The graphical target could not be opened in an editor.');
            }
        } catch (_error) {
            if (this.isCurrentNavigation(state, accepted, target, cancellation)) {
                state.navigationCancellation = undefined;
                cancellation.dispose();
                await this.warnNavigation('The graphical target is temporarily unavailable.');
            }
        }
    }

    private isCurrentNavigation(
        state: PanelState,
        accepted: GraphicalViewAcceptedResult,
        target: Readonly<GraphicalViewTarget>,
        cancellation: vscode.CancellationTokenSource,
    ): boolean {
        return state.navigationCancellation === cancellation && this.isCurrentNavigationResult(state, accepted, target);
    }

    private isCurrentNavigationResult(
        state: PanelState,
        accepted: GraphicalViewAcceptedResult,
        target: Readonly<GraphicalViewTarget>,
    ): boolean {
        return this.isCurrent(state)
            && state.lastSuccess === accepted
            && accepted.targetById.get(target.id) === target;
    }

    private async warnNavigation(message: string): Promise<void> {
        await this.window.showWarningMessage(message);
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
        const reason = classifyFailure(detail);
        this.outputChannel.warn(`Graphical view render request failed (${reason}).`);
        this.setStale(state, reason, 'Graphical rendering failed. The last successful diagram is retained.');
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
        const accepted = state.pendingDelivery?.accepted ?? state.lastSuccess;
        if (accepted) {
            state.panel.deliver(Object.freeze({type: 'render', version: accepted.version, svg: accepted.svg}));
        }
    }

    private deliverStatus(state: PanelState): void {
        state.panel.deliver(Object.freeze({type: 'status', status: state.status}));
    }

    private invalidate(state: PanelState): void {
        if (!this.isCurrent(state)) {
            return;
        }
        this.cancelCurrent(state);
        this.cancelNavigation(state);
        state.pendingDelivery = undefined;
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

    private cancelNavigation(state: PanelState): void {
        const cancellation = state.navigationCancellation;
        state.navigationCancellation = undefined;
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
        this.cancelNavigation(state);
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

function createAcceptedResult(result: GraphicalViewRenderResult, svg: string, version: number): GraphicalViewAcceptedResult {
    const targets = Object.freeze(result.targets.map(target => Object.freeze({...target})));
    const warnings = Object.freeze([...result.warnings]);
    const targetById = new ImmutableTargetMap(targets.map(target => [target.id, target]));
    return Object.freeze({version, uri: result.uri, svg, targets, warnings, targetById});
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
    const keys = Object.keys(value).sort();
    if ((value.type === 'ready' || value.type === 'refresh') && keys.length === 1) {
        return true;
    }
    if (value.type === 'rendered') {
        return keys.length === 2 && keys[0] === 'type' && keys[1] === 'version' && isDisplayedVersion(value.version);
    }
    if (value.type === 'renderError') {
        return keys.length === 3
            && keys[0] === 'reason'
            && keys[1] === 'type'
            && keys[2] === 'version'
            && value.reason === 'sanitizationFailed'
            && isDisplayedVersion(value.version);
    }
    return value.type === 'navigate'
        && keys.length === 3
        && keys[0] === 'targetId'
        && keys[1] === 'type'
        && keys[2] === 'version'
        && isDisplayedVersion(value.version)
        && typeof value.targetId === 'string'
        && GRAPHICAL_VIEW_MARKER_PATTERN.test(value.targetId);
}

function isDisplayedVersion(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

type ValidatedResolveTarget =
    | Readonly<{kind: 'location'; uri: vscode.Uri; start: vscode.Position; end: vscode.Position}>
    | Readonly<{kind: 'warning'; warning: GraphicalViewResolveWarning}>
    | Readonly<{kind: 'invalid'}>;

type GraphicalViewResolveWarning = 'notFound' | 'ambiguous' | 'unsupportedUri' | 'temporarilyUnresolvable';

const RESOLVE_WARNINGS: ReadonlySet<string> = new Set([
    'notFound',
    'ambiguous',
    'unsupportedUri',
    'temporarilyUnresolvable',
]);

function validateResolveTargetResult(value: unknown): ValidatedResolveTarget {
    if (!isRecord(value) || !hasOnlyKeys(value, ['location', 'warning'])) {
        return {kind: 'invalid'};
    }

    const warning = value.warning;
    if (warning !== undefined && warning !== null && (typeof warning !== 'string' || !RESOLVE_WARNINGS.has(warning))) {
        return {kind: 'invalid'};
    }
    const location = value.location;
    if (location === undefined || location === null) {
        return typeof warning === 'string'
            ? {kind: 'warning', warning: warning as GraphicalViewResolveWarning}
            : {kind: 'invalid'};
    }
    if (warning !== undefined && warning !== null) {
        return {kind: 'invalid'};
    }
    if (!isRecord(location) || !hasExactKeys(location, ['range', 'uri']) || typeof location.uri !== 'string') {
        return {kind: 'invalid'};
    }
    const range = location.range;
    if (!isRecord(range) || !hasExactKeys(range, ['end', 'start'])) {
        return {kind: 'invalid'};
    }
    const start = validatePosition(range.start);
    const end = validatePosition(range.end);
    if (!start || !end || start.isAfter(end)) {
        return {kind: 'invalid'};
    }

    try {
        const uri = vscode.Uri.parse(location.uri, true);
        if (uri.scheme !== 'file'
            || uri.authority !== ''
            || !uri.path.startsWith('/')
            || uri.query !== ''
            || uri.fragment !== ''
            || uri.fsPath.includes('\0')) {
            return {kind: 'warning', warning: 'unsupportedUri'};
        }
        return {kind: 'location', uri, start, end};
    } catch (_error) {
        return {kind: 'invalid'};
    }
}

function validatePosition(value: unknown): vscode.Position | undefined {
    if (!isRecord(value)
        || !hasExactKeys(value, ['character', 'line'])
        || !Number.isSafeInteger(value.line)
        || !Number.isSafeInteger(value.character)
        || (value.line as number) < 0
        || (value.character as number) < 0) {
        return undefined;
    }
    return new vscode.Position(value.line as number, value.character as number);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
    const allowed = new Set(allowedKeys);
    return Object.keys(value).every(key => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
    const actualKeys = Object.keys(value).sort();
    return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function resolveWarningMessage(warning: GraphicalViewResolveWarning): string {
    switch (warning) {
        case 'notFound':
            return 'The graphical target no longer exists in the current model.';
        case 'ambiguous':
            return 'The graphical target is ambiguous in the current model.';
        case 'unsupportedUri':
            return 'The graphical target is not a local file and cannot be opened.';
        case 'temporarilyUnresolvable':
            return 'The graphical target is temporarily unavailable. Fix any model syntax errors and try again.';
    }
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
