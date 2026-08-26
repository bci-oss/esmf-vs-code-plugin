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
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {OPEN_GRAPHICAL_VIEW_COMMAND} from '../graphicalView';
import {GraphicalViewRenderResult} from '../graphicalViewProtocol';
import {
    FakeGraphicalViewClient,
    createGraphicalViewDocument,
    createGraphicalViewHarness,
    flushPromises,
    successfulResult,
} from './graphicalViewTestHarness';

suite('GraphicalViewController', () => {
    test('contributes the guarded Turtle editor command', () => {
        const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
            contributes: {commands: Array<Record<string, string>>; menus: {'editor/context': Array<Record<string, string>>}};
        };
        const command = manifest.contributes.commands.find(candidate => candidate.command === OPEN_GRAPHICAL_VIEW_COMMAND);
        const menu = manifest.contributes.menus['editor/context'].find(candidate => candidate.command === OPEN_GRAPHICAL_VIEW_COMMAND);
        assert.equal(command?.enablement, 'editorLangId == turtle');
        assert.equal(menu?.when, 'resourceLangId == turtle');
    });

    test('guards absent and non-Turtle active editors without a panel or request', async () => {
        const harness = createGraphicalViewHarness();
        await harness.commands.execute(OPEN_GRAPHICAL_VIEW_COMMAND);
        harness.window.activeTextEditor = {document: createGraphicalViewDocument('/tmp/not-turtle.txt', 'plaintext')};
        await harness.commands.execute(OPEN_GRAPHICAL_VIEW_COMMAND);
        assert.equal(harness.window.warnings.length, 2);
        assert.equal(harness.panels.panels.length, 0);
        assert.equal(harness.client.requests.length, 0);
        harness.controller.dispose();
    });

    test('creates one panel and performs the initial typed render', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/initial.ttl');
        harness.window.activeTextEditor = {document};
        await harness.commands.execute(OPEN_GRAPHICAL_VIEW_COMMAND);
        assert.equal(harness.panels.panels.length, 1);
        assert.deepEqual(harness.client.requests[0].params, {uri: document.uri.toString()});
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.sequence, 1);

        harness.client.requests[0].deferred.resolve(successfulResult(document));
        await flushPromises();
        const state = harness.controller.getPanelState(document.uri.toString());
        assert.equal(state?.status.kind, 'ready');
        assert.equal(state?.lastSuccess?.svg, successfulResult(document).svg);
        assert.equal(state?.lastSuccess?.targetById.size, 1);
        harness.controller.dispose();
    });

    test('reveals one panel per URI and keeps different URI panels independent', async () => {
        const harness = createGraphicalViewHarness();
        const first = track(harness, '/tmp/first.ttl');
        const second = track(harness, '/tmp/second.ttl');
        await harness.controller.openGraphicalView(first);
        await harness.controller.openGraphicalView(first);
        assert.equal(harness.panels.panels.length, 1);
        assert.equal(harness.panels.panels[0].revealCount, 1);
        assert.equal(harness.client.requests.length, 1);

        await harness.controller.openGraphicalView(second);
        assert.equal(harness.controller.getPanelCount(), 2);
        assert.equal(harness.client.requests.length, 2);
        assert.equal(harness.client.requests[1].params.uri, second.uri.toString());
        harness.controller.dispose();
    });

    test('renders on manual Refresh and visible bound-main Save only', async () => {
        const harness = createGraphicalViewHarness();
        const main = track(harness, '/tmp/main.ttl');
        const imported = track(harness, '/tmp/import.ttl');
        await harness.controller.openGraphicalView(main);
        harness.panels.panels[0].emitMessage({type: 'refresh'});
        assert.equal(harness.client.requests.length, 2);
        assert.equal(harness.client.requests[0].token.isCancellationRequested, true);

        harness.workspace.fireSave(imported);
        assert.equal(harness.client.requests.length, 2);
        harness.workspace.fireSave(main);
        assert.equal(harness.client.requests.length, 3);
        assert.equal(harness.client.requests[1].token.isCancellationRequested, true);
        harness.controller.dispose();
    });

    test('hidden Save invalidates pending work; typing and reveal do not render', async () => {
        const harness = createGraphicalViewHarness();
        const main = track(harness, '/tmp/hidden.ttl');
        await harness.controller.openGraphicalView(main);
        harness.client.requests[0].deferred.resolve(successfulResult(main));
        await flushPromises();
        const panel = harness.panels.panels[0];
        panel.emitMessage({type: 'refresh'});
        const pending = harness.client.requests[1];
        panel.setVisible(false);
        panel.emitMessage({type: 'refresh'});
        assert.equal(harness.client.requests.length, 2);
        const before = harness.controller.getPanelState(main.uri.toString())?.sequence;
        harness.workspace.fireSave(main);
        assert.equal(harness.client.requests.length, 2);
        assert.equal(pending.token.isCancellationRequested, true);
        assert.equal(harness.controller.getPanelState(main.uri.toString())?.sequence, (before ?? 0) + 1);
        assert.equal(harness.controller.getPanelState(main.uri.toString())?.status.kind, 'ready');
        assert.ok(harness.controller.getPanelState(main.uri.toString())?.lastSuccess);

        panel.setVisible(true);
        panel.emitMessage({type: 'ready'});
        panel.emitMessage({type: 'navigate', targetId: 'gv-header-0123456789abcdef'});
        assert.equal(harness.client.requests.length, 2);
        harness.controller.dispose();
    });

    test('source editor closure invalidates pending work and ignores its late failure', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/closed.ttl');
        await harness.controller.openGraphicalView(document);
        harness.client.requests[0].deferred.resolve(successfulResult(document));
        await flushPromises();
        const retained = harness.controller.getPanelState(document.uri.toString())?.lastSuccess;
        harness.panels.panels[0].emitMessage({type: 'refresh'});
        const pending = harness.client.requests[1];
        const sequence = harness.controller.getPanelState(document.uri.toString())?.sequence ?? 0;

        harness.workspace.closeSourceEditor(document);
        assert.equal(harness.controller.getPanelCount(), 1);
        assert.equal(harness.client.requests.length, 2);
        assert.equal(pending.token.isCancellationRequested, true);
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.sequence, sequence + 1);
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.lastSuccess, retained);

        pending.deferred.reject(new Error('late transport failure'));
        await flushPromises();
        const state = harness.controller.getPanelState(document.uri.toString());
        assert.equal(state?.status.kind, 'ready');
        assert.equal(state?.lastSuccess, retained);
        harness.controller.dispose();
    });

    test('bound-source loss invalidates pending work and ignores its late success', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/lost.ttl');
        await harness.controller.openGraphicalView(document);
        const retainedResult = successfulResult(document, 'aaaaaaaaaaaaaaaa');
        harness.client.requests[0].deferred.resolve(retainedResult);
        await flushPromises();
        const retained = harness.controller.getPanelState(document.uri.toString())?.lastSuccess;

        harness.panels.panels[0].emitMessage({type: 'refresh'});
        const pending = harness.client.requests[1];
        const sequence = harness.controller.getPanelState(document.uri.toString())?.sequence ?? 0;
        harness.workspace.loseDocument(document);
        assert.equal(harness.client.requests.length, 2);
        assert.equal(pending.token.isCancellationRequested, true);
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.sequence, sequence + 1);

        pending.deferred.resolve(successfulResult(document, 'bbbbbbbbbbbbbbbb'));
        await flushPromises();
        const state = harness.controller.getPanelState(document.uri.toString());
        assert.equal(state?.status.kind, 'ready');
        assert.equal(state?.lastSuccess, retained);
        assert.equal(state?.lastSuccess?.svg, retainedResult.svg);
        harness.controller.dispose();
    });

    test('cancels superseded work and rejects obsolete success and failure completions', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/sequence.ttl');
        await harness.controller.openGraphicalView(document);
        const first = harness.client.requests[0];
        harness.panels.panels[0].emitMessage({type: 'refresh'});
        const second = harness.client.requests[1];
        assert.equal(first.token.isCancellationRequested, true);

        second.deferred.resolve(successfulResult(document, '1111111111111111'));
        await flushPromises();
        first.deferred.resolve(successfulResult(document, '2222222222222222'));
        await flushPromises();
        assert.match(harness.controller.getPanelState(document.uri.toString())?.lastSuccess?.svg ?? '', /1111111111111111/);

        harness.panels.panels[0].emitMessage({type: 'refresh'});
        const obsoleteFailure = harness.client.requests[2];
        harness.panels.panels[0].emitMessage({type: 'refresh'});
        const newest = harness.client.requests[3];
        obsoleteFailure.deferred.reject(new Error('obsolete transport failure'));
        await flushPromises();
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.status.kind, 'loading');
        newest.deferred.resolve(successfulResult(document, '3333333333333333'));
        await flushPromises();
        assert.match(harness.controller.getPanelState(document.uri.toString())?.lastSuccess?.svg ?? '', /3333333333333333/);
        harness.controller.dispose();
    });

    test('rejects URI mismatches and malformed, duplicate, invalid-marker, and inconsistent sidecars', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/validation.ttl');
        await harness.controller.openGraphicalView(document);
        const good = successfulResult(document);
        harness.client.requests[0].deferred.resolve(good);
        await flushPromises();

        const invalidResults: GraphicalViewRenderResult[] = [
            {...good, uri: 'file:///tmp/other.ttl'},
            {...good, targets: [...good.targets, good.targets[0]]},
            {...good, targets: [{...good.targets[0], id: 'bad-marker'}]},
            {...good, targets: [{...good.targets[0], kind: 'notHeader' as 'elementHeader'}]},
            {...good, targets: [{...good.targets[0], elementUrn: 'not-a-urn'}]},
            {...good, svg: '<svg></svg>'},
        ];

        for (const invalid of invalidResults) {
            harness.panels.panels[0].emitMessage({type: 'refresh'});
            harness.client.requests.at(-1)?.deferred.resolve(invalid);
            await flushPromises();
            const state = harness.controller.getPanelState(document.uri.toString());
            assert.equal(state?.status.kind, 'stale');
            assert.equal(state?.lastSuccess?.svg, good.svg);
            assert.equal(state?.lastSuccess?.targetById.get(good.targets[0].id)?.elementUrn, good.targets[0].elementUrn);
        }
        harness.controller.dispose();
    });

    test('installs SVG and sidecar atomically and retains them for all failure classes', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/retention.ttl');
        await harness.controller.openGraphicalView(document);
        const accepted = successfulResult(document, 'aaaaaaaaaaaaaaaa');
        harness.client.requests[0].deferred.resolve(accepted);
        await flushPromises();
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.lastSuccess?.targetById.has(accepted.targets[0].id), true);

        const failures: Array<GraphicalViewRenderResult | Error> = [
            {uri: document.uri.toString(), svg: null, targets: [], warnings: ['temporarilyUnresolvable']},
            {uri: document.uri.toString(), targets: [], warnings: ['timeout']},
            {uri: document.uri.toString(), svg: null, targets: [], warnings: ['modelTooLarge']},
            new Error('transport socket closed'),
            new Error('generic failure'),
        ];
        for (const failure of failures) {
            harness.panels.panels[0].emitMessage({type: 'refresh'});
            const request = harness.client.requests.at(-1);
            if (failure instanceof Error) {
                request?.deferred.reject(failure);
            } else {
                request?.deferred.resolve(failure);
            }
            await flushPromises();
            const state = harness.controller.getPanelState(document.uri.toString());
            assert.equal(state?.status.kind, 'stale');
            assert.equal(state?.lastSuccess?.svg, accepted.svg);
            assert.equal(state?.lastSuccess?.targetById.has(accepted.targets[0].id), true);
        }
        harness.controller.dispose();
    });

    test('detects MethodNotFound by code and recovers compatibility state after client replacement', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/unsupported.ttl');
        await harness.controller.openGraphicalView(document);
        harness.client.requests[0].deferred.reject(Object.assign(new Error('localized message'), {code: -32601}));
        await flushPromises();
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.status.kind, 'unsupported');

        const replacement = new FakeGraphicalViewClient();
        harness.controller.setClient(replacement);
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.status.kind, 'stale');
        assert.equal(replacement.requests.length, 0);
        harness.panels.panels[0].emitMessage({type: 'refresh'});
        assert.equal(replacement.requests.length, 1);
        harness.controller.dispose();
    });

    test('handles explicit replacement and unexpected disconnect/reconnect without automatic render', async () => {
        const client = new FakeGraphicalViewClient();
        const harness = createGraphicalViewHarness(client);
        const document = track(harness, '/tmp/lifecycle.ttl');
        await harness.controller.openGraphicalView(document);
        const pending = client.requests[0];
        harness.controller.setClient(undefined);
        assert.equal(pending.token.isCancellationRequested, true);
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.status.kind, 'disconnected');

        const replacement = new FakeGraphicalViewClient();
        harness.controller.setClient(replacement);
        assert.equal(replacement.requests.length, 0);
        replacement.setAvailable(false);
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.status.kind, 'disconnected');
        replacement.setAvailable(true);
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.status.kind, 'stale');
        assert.equal(replacement.requests.length, 0);
        harness.controller.dispose();
    });

    test('disposal removes ownership, cancels work, disposes listeners, and rejects late results', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/dispose.ttl');
        await harness.controller.openGraphicalView(document);
        const request = harness.client.requests[0];
        const panel = harness.panels.panels[0];
        panel.dispose();
        assert.equal(harness.controller.getPanelCount(), 0);
        assert.equal(request.token.isCancellationRequested, true);
        assert.equal(panel.disposedListenerCount, 3);
        request.deferred.resolve(successfulResult(document));
        await flushPromises();
        assert.equal(harness.controller.getPanelCount(), 0);
        harness.controller.dispose();
    });

    test('multiple panels neither leak nor cross-deliver results or status', async () => {
        const harness = createGraphicalViewHarness();
        const first = track(harness, '/tmp/multi-one.ttl');
        const second = track(harness, '/tmp/multi-two.ttl');
        await harness.controller.openGraphicalView(first);
        await harness.controller.openGraphicalView(second);
        const firstDeliveryCount = harness.panels.panels[0].deliveries.length;
        harness.client.requests[1].deferred.resolve(successfulResult(second, 'bbbbbbbbbbbbbbbb'));
        await flushPromises();
        assert.equal(harness.panels.panels[0].deliveries.length, firstDeliveryCount);
        assert.match(harness.controller.getPanelState(second.uri.toString())?.lastSuccess?.svg ?? '', /bbbbbbbbbbbbbbbb/);
        assert.equal(harness.controller.getPanelState(first.uri.toString())?.lastSuccess, undefined);
        harness.controller.dispose();
        assert.equal(harness.panels.panels[0].disposeCount, 1);
        assert.equal(harness.panels.panels[1].disposeCount, 1);
    });
});

function track(harness: ReturnType<typeof createGraphicalViewHarness>, filePath: string) {
    const document = createGraphicalViewDocument(filePath);
    harness.workspace.available.add(document.uri.toString());
    return document;
}
