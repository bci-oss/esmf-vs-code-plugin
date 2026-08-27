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
import * as vscode from 'vscode';
import {Trace} from 'vscode-jsonrpc';
import {State, StateChangeEvent} from 'vscode-languageclient/node';
import {
    GRAPHICAL_VIEW_RENDER_REQUEST,
    GRAPHICAL_VIEW_RESOLVE_ATTRIBUTE_TARGET_REQUEST,
    GRAPHICAL_VIEW_RESOLVE_TARGET_REQUEST,
    GraphicalViewRenderResult,
    GraphicalViewResolveTargetResult,
    isGraphicalViewRenderResult,
} from '../graphicalViewProtocol';
import {LanguageClientAdapter, TurtleLanguageClient} from '../languageClient';
import type {ExtensionLogger} from '../outputChannel';

suite('TurtleLanguageClient graphical-view integration', () => {
    test('forwards exact typed methods and render cancellation token', async () => {
        const adapter = new FakeLanguageClientAdapter();
        const client = new TurtleLanguageClient(new FakeLogger(), 1846, 'off', () => adapter);
        await client.connect();
        const cancellation = new vscode.CancellationTokenSource();

        const render = await client.renderGraphicalView({uri: 'file:///model.ttl'}, cancellation.token);
        const resolve = await client.resolveGraphicalViewTarget({
            sourceUri: 'file:///model.ttl',
            elementUrn: 'urn:samm:example:1.0.0#Aspect',
        });
        const resolveAttribute = await client.resolveGraphicalViewAttributeTarget({
            sourceUri: 'file:///model.ttl',
            ownerUrn: 'urn:samm:example:1.0.0#Aspect',
            predicateUrn: 'urn:samm:org.eclipse.esmf.samm:meta-model:2.2.0#description',
            selection: 'singleOccurrence',
            language: 'en',
        });

        assert.equal(render.uri, 'file:///model.ttl');
        assert.equal(resolve.warning, 'notFound');
        assert.equal(resolveAttribute.warning, 'notFound');
        assert.equal(adapter.requests[0].method, GRAPHICAL_VIEW_RENDER_REQUEST);
        assert.equal(adapter.requests[0].token, cancellation.token);
        assert.equal(adapter.requests[1].method, GRAPHICAL_VIEW_RESOLVE_TARGET_REQUEST);
        assert.equal(adapter.requests[2].method, GRAPHICAL_VIEW_RESOLVE_ATTRIBUTE_TARGET_REQUEST);
        cancellation.dispose();
    });

    test('exposes disconnect and reconnect transitions once per availability change', async () => {
        const adapter = new FakeLanguageClientAdapter();
        const client = new TurtleLanguageClient(new FakeLogger(), 1846, 'off', () => adapter);
        const events: boolean[] = [];
        const subscription = client.onDidChangeGraphicalViewAvailability(available => events.push(available));

        await client.connect();
        adapter.transition(State.Starting);
        adapter.transition(State.Stopped);
        adapter.transition(State.Running);
        assert.deepEqual(events, [true, false, true]);
        subscription.dispose();
    });

    test('accepts Task 2 render warning JSON with omitted or explicit-null svg', () => {
        const omittedSvg = JSON.parse(
            '{"uri":"file:///model.ttl","targets":[],"warnings":["timeout"]}',
        ) as unknown;
        const nullSvg = JSON.parse(
            '{"uri":"file:///model.ttl","svg":null,"targets":[],"warnings":["modelTooLarge"]}',
        ) as unknown;
        const missingSuccessfulSvg = JSON.parse(
            '{"uri":"file:///model.ttl","targets":[],"warnings":[]}',
        ) as unknown;

        assert.equal(isGraphicalViewRenderResult(omittedSvg), true);
        assert.equal(isGraphicalViewRenderResult(nullSvg), true);
        assert.equal(isGraphicalViewRenderResult(missingSuccessfulSvg), false);
    });

    test('models omitted and explicit-null resolve result fields from Task 2 JSON', () => {
        const omittedLocation = JSON.parse('{"warning":"notFound"}') as GraphicalViewResolveTargetResult;
        const omittedWarning = JSON.parse(
            '{"location":{"uri":"file:///model.ttl","range":{"start":{"line":1,"character":2},"end":{"line":1,"character":3}}}}',
        ) as GraphicalViewResolveTargetResult;
        const explicitNulls = JSON.parse('{"location":null,"warning":null}') as GraphicalViewResolveTargetResult;

        assert.equal(omittedLocation.location, undefined);
        assert.equal(omittedLocation.warning, 'notFound');
        assert.equal(omittedWarning.warning, undefined);
        assert.equal(omittedWarning.location?.uri, 'file:///model.ttl');
        assert.equal(explicitNulls.location, null);
        assert.equal(explicitNulls.warning, null);
    });
});

class FakeLanguageClientAdapter implements LanguageClientAdapter {
    state = State.Stopped;
    readonly requests: Array<{method: string; params: unknown; token: vscode.CancellationToken | undefined}> = [];
    private readonly listeners = new Set<(event: StateChangeEvent) => void>();

    setTrace(_value: Trace): void {}

    start(): Promise<void> {
        this.transition(State.Running);
        return Promise.resolve();
    }

    stop(): Promise<void> {
        this.transition(State.Stopped);
        return Promise.resolve();
    }

    onDidChangeState(listener: (event: StateChangeEvent) => void): vscode.Disposable {
        this.listeners.add(listener);
        return new vscode.Disposable(() => this.listeners.delete(listener));
    }

    sendRequest<R>(method: string, params?: unknown, token?: vscode.CancellationToken): Promise<R> {
        this.requests.push({method, params, token});
        if (method === GRAPHICAL_VIEW_RENDER_REQUEST) {
            const result: GraphicalViewRenderResult = {uri: 'file:///model.ttl', svg: '<svg/>', targets: [], warnings: []};
            return Promise.resolve(result as R);
        }
        const result: GraphicalViewResolveTargetResult = {location: null, warning: 'notFound'};
        return Promise.resolve(result as R);
    }

    transition(newState: State): void {
        const oldState = this.state;
        this.state = newState;
        for (const listener of [...this.listeners]) {
            listener({oldState, newState});
        }
    }
}

class FakeLogger implements ExtensionLogger {
    trace(_message: string): void {}
    info(_message: string): void {}
    warn(_message: string): void {}
    error(_message: string | Error): void {}
}
