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
import * as vscode from 'vscode';
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
        assert.deepEqual(harness.client.requests[0].params, {uri: document.uri.toString(), includeAttributeRows: true});
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
            {...good, targets: [{...good.targets[0], extra: 'rejected'}] as never},
            {...good, svg: `${good.svg}<g id="gv-attribute-BAD"></g>`},
        ];

        for (const invalid of invalidResults) {
            harness.panels.panels[0].emitMessage({type: 'refresh'});
            harness.client.requests.at(-1)?.deferred.resolve(invalid);
            await flushPromises();
            const state = harness.controller.getPanelState(document.uri.toString());
            assert.equal(state?.status.kind, 'stale');
            assert.equal(state?.lastSuccess?.svg, good.svg);
            const retainedTarget = state?.lastSuccess?.targetById.get(good.targets[0].id);
            assert.equal(retainedTarget?.kind, 'elementHeader');
            assert.equal(retainedTarget?.kind === 'elementHeader' ? retainedTarget.elementUrn : undefined, good.targets[0].elementUrn);
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

    test('commits a sidecar only after secure render confirmation and retains last-good state on render rejection', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/secure-render.ttl');
        await harness.controller.openGraphicalView(document);
        const first = successfulResult(document, 'aaaaaaaaaaaaaaaa');
        harness.client.requests[0].deferred.resolve(first);
        await flushPromises();
        const retained = harness.controller.getPanelState(document.uri.toString())?.lastSuccess;
        assert.equal(retained?.version, 1);

        const panel = harness.panels.panels[0];
        panel.renderOutcome = 'failure';
        panel.emitMessage({type: 'refresh'});
        const rejected = successfulResult(document, 'bbbbbbbbbbbbbbbb');
        harness.client.requests[1].deferred.resolve(rejected);
        await flushPromises();

        const state = harness.controller.getPanelState(document.uri.toString());
        assert.equal(state?.status.kind, 'stale');
        assert.equal(state?.lastSuccess, retained);
        assert.equal(state?.lastSuccess?.targetById.has(first.targets[0].id), true);
        assert.equal(state?.lastSuccess?.targetById.has(rejected.targets[0].id), false);
        harness.controller.dispose();
    });

    test('late acknowledgement for delivered A establishes its sidecar without overwriting loading state for B', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/delayed-render-ack-loading.ttl');
        await harness.controller.openGraphicalView(document);
        const panel = harness.panels.panels[0];
        panel.renderOutcome = 'none';

        harness.client.requests[0].deferred.resolve(successfulResult(document, 'aaaaaaaaaaaaaaaa'));
        await flushPromises();
        panel.emitMessage({type: 'refresh'});
        const loadingB = harness.controller.getPanelState(document.uri.toString())?.status;

        panel.emitMessage({type: 'rendered', version: 1});
        const state = harness.controller.getPanelState(document.uri.toString());
        assert.equal(state?.lastSuccess?.version, 1);
        assert.equal(state?.status, loadingB);
        assert.equal(state?.status.kind, 'loading');
        harness.controller.dispose();
    });

    test('late acknowledgement for delivered A establishes its sidecar without overwriting failed state for B', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/delayed-render-ack-stale.ttl');
        await harness.controller.openGraphicalView(document);
        const panel = harness.panels.panels[0];
        panel.renderOutcome = 'none';

        harness.client.requests[0].deferred.resolve(successfulResult(document, 'aaaaaaaaaaaaaaaa'));
        await flushPromises();
        panel.emitMessage({type: 'refresh'});
        harness.client.requests[1].deferred.reject(new Error('render B failed'));
        await flushPromises();
        const failedB = harness.controller.getPanelState(document.uri.toString())?.status;

        panel.emitMessage({type: 'rendered', version: 1});
        const state = harness.controller.getPanelState(document.uri.toString());
        assert.equal(state?.lastSuccess?.version, 1);
        assert.equal(state?.status, failedB);
        assert.equal(state?.status.kind, 'stale');
        harness.controller.dispose();
    });

    test('rehydrates the current version through ready without an LSP render or shell reset', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/rehydrate.ttl');
        await harness.controller.openGraphicalView(document);
        harness.client.requests[0].deferred.resolve(successfulResult(document));
        await flushPromises();
        const panel = harness.panels.panels[0];
        const renderCount = panel.deliveries.filter(delivery => delivery.type === 'render').length;

        panel.emitMessage({type: 'ready'});
        assert.equal(harness.client.requests.length, 1);
        assert.equal(panel.deliveries.filter(delivery => delivery.type === 'render').length, renderCount + 1);
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.lastSuccess?.version, 1);

        panel.renderOutcome = 'failure';
        panel.emitMessage({type: 'refresh'});
        harness.client.requests[1].deferred.resolve(successfulResult(document, 'bbbbbbbbbbbbbbbb'));
        await flushPromises();
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.status.kind, 'stale');

        panel.renderOutcome = 'success';
        panel.emitMessage({type: 'ready'});
        assert.equal(harness.client.requests.length, 2);
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.lastSuccess?.version, 1);
        assert.equal(harness.controller.getPanelState(document.uri.toString())?.status.kind, 'stale');
        harness.controller.dispose();
    });

    test('resolves a current sidecar-backed marker and opens, selects, and reveals only its local file location', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/navigation-source.ttl');
        await harness.controller.openGraphicalView(document);
        const result = successfulResult(document);
        harness.client.requests[0].deferred.resolve(result);
        await flushPromises();
        const targetUri = vscode.Uri.file('/tmp/navigation-target.ttl');
        harness.client.resolveResult = {
            location: {
                uri: targetUri.toString(),
                range: {start: {line: 3, character: 4}, end: {line: 5, character: 6}},
            },
        };

        harness.panels.panels[0].emitMessage({type: 'navigate', version: 1, targetId: result.targets[0].id});
        await flushPromises();
        await flushPromises();

        assert.deepEqual(harness.client.resolveRequests[0].params, {
            sourceUri: document.uri.toString(),
            elementUrn: result.targets[0].elementUrn,
        });
        assert.equal(harness.client.resolveRequests[0].token?.isCancellationRequested, false);
        assert.equal(harness.window.openedEditors[0].uri.toString(), targetUri.toString());
        assert.equal(harness.window.openedEditors[0].options?.preview, false);
        assert.deepEqual(harness.window.openedEditors[0].editor.selection.start, new vscode.Position(3, 4));
        assert.deepEqual(harness.window.openedEditors[0].editor.selection.end, new vscode.Position(5, 6));
        assert.deepEqual(harness.window.openedEditors[0].revealedRanges[0], new vscode.Range(3, 4, 5, 6));
        harness.controller.dispose();
    });

    test('accepts an exact attribute sidecar and routes only its trusted semantic selector to the attribute resolver', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/attribute-navigation-source.ttl');
        await harness.controller.openGraphicalView(document);
        const id = 'gv-attribute-0123456789abcdef';
        const result: GraphicalViewRenderResult = {
            uri: document.uri.toString(),
            svg: `<svg><g id="${id}"><polygon points="0,0 1,0 1,1"/><text x="0" y="0">description: row</text></g></svg>`,
            targets: [{
                id,
                kind: 'attributeRow',
                ownerUrn: 'urn:samm:example.graphical:1.0.0#Aspect',
                predicateUrn: 'urn:samm:org.eclipse.esmf.samm:meta-model:2.2.0#description',
                selection: 'singleOccurrence',
                language: 'en',
            }],
            warnings: [],
        };
        harness.client.requests[0].deferred.resolve(result);
        await flushPromises();
        harness.client.resolveResult = {
            location: {
                uri: vscode.Uri.file('/tmp/attribute-navigation-target.ttl').toString(),
                range: {start: {line: 7, character: 3}, end: {line: 7, character: 19}},
            },
        };

        harness.panels.panels[0].emitMessage({type: 'navigate', version: 1, targetId: id});
        await flushPromises();
        await flushPromises();

        assert.equal(harness.client.resolveRequests.length, 0);
        assert.deepEqual(harness.client.attributeResolveRequests[0].params, {
            sourceUri: document.uri.toString(),
            ownerUrn: 'urn:samm:example.graphical:1.0.0#Aspect',
            predicateUrn: 'urn:samm:org.eclipse.esmf.samm:meta-model:2.2.0#description',
            selection: 'singleOccurrence',
            language: 'en',
        });
        assert.deepEqual(harness.window.openedEditors[0].editor.selection.start, new vscode.Position(7, 3));
        harness.controller.dispose();
    });

    test('opens the same predicate statement from both physical rows of a wrapped aggregated see target', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/wrapped-see-source.ttl');
        await harness.controller.openGraphicalView(document);
        const ids = ['gv-attribute-1111111111111111', 'gv-attribute-2222222222222222'] as const;
        const locator = {
            kind: 'attributeRow' as const,
            ownerUrn: 'urn:samm:example.graphical:1.0.0#Aspect',
            predicateUrn: 'urn:samm:org.eclipse.esmf.samm:meta-model:2.2.0#see',
            selection: 'predicateStart' as const,
        };
        const result: GraphicalViewRenderResult = {
            uri: document.uri.toString(),
            svg: `<svg><g id="${ids[0]}"><text>see: urn:irdi:0173:1:02:AAO677:002,</text></g>`
                + `<g id="${ids[1]}"><text>urn:irdi:0173:1:02:AAO677:003</text></g></svg>`,
            targets: ids.map(id => ({id, ...locator})),
            warnings: [],
        };
        harness.client.requests[0].deferred.resolve(result);
        await flushPromises();
        const targetUri = vscode.Uri.file('/tmp/wrapped-see-source.ttl');
        harness.client.resolveResult = {
            location: {
                uri: targetUri.toString(),
                range: {start: {line: 8, character: 3}, end: {line: 8, character: 11}},
            },
        };

        for (const id of ids) {
            harness.panels.panels[0].emitMessage({type: 'navigate', version: 1, targetId: id});
            await flushPromises();
            await flushPromises();
        }

        assert.equal(harness.client.attributeResolveRequests.length, 2);
        const expectedParams = {
            sourceUri: document.uri.toString(),
            ownerUrn: locator.ownerUrn,
            predicateUrn: locator.predicateUrn,
            selection: locator.selection,
        };
        assert.deepEqual(harness.client.attributeResolveRequests.map(request => request.params), [expectedParams, expectedParams]);
        assert.equal(harness.window.openedEditors.length, 2);
        assert.ok(harness.window.openedEditors.every(opened => opened.uri.toString() === targetUri.toString()));
        assert.ok(harness.window.openedEditors.every(
            opened => opened.editor.selection.isEqual(new vscode.Selection(8, 3, 8, 11)),
        ));
        assert.equal(harness.window.warnings.length, 0);
        harness.controller.dispose();
    });

    test('rejects attribute kind-prefix-shape-qualifier and sidecar inconsistencies atomically', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/attribute-validation.ttl');
        await harness.controller.openGraphicalView(document);
        const good = successfulResult(document);
        harness.client.requests[0].deferred.resolve(good);
        await flushPromises();
        const base = {
            id: 'gv-attribute-0123456789abcdef',
            kind: 'attributeRow' as const,
            ownerUrn: 'urn:samm:example.graphical:1.0.0#Aspect',
            predicateUrn: 'urn:samm:org.eclipse.esmf.samm:meta-model:2.2.0#description',
            selection: 'singleOccurrence' as const,
            language: 'en',
        };
        const candidates: unknown[] = [
            {...base, id: 'gv-header-0123456789abcdef'},
            {...base, ownerUrn: 'Aspect'},
            {...base, predicateUrn: 'description'},
            {...base, selection: 'predicateStart', language: 'en'},
            {...base, language: 'EN'},
            {...base, sourceText: 'forbidden'},
        ];
        for (const target of candidates) {
            harness.panels.panels[0].emitMessage({type: 'refresh'});
            const id = (target as {id: string}).id;
            harness.client.requests.at(-1)?.deferred.resolve({
                uri: document.uri.toString(),
                svg: `<svg><g id="${id}"><text>row</text></g></svg>`,
                targets: [target] as never,
                warnings: [],
            });
            await flushPromises();
            assert.equal(harness.controller.getPanelState(document.uri.toString())?.lastSuccess?.svg, good.svg);
        }
        harness.controller.dispose();
    });

    test('falls back once to legacy header-only render on InvalidParams and exposes the compatibility limitation', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/legacy-server.ttl');
        await harness.controller.openGraphicalView(document);
        harness.client.requests[0].deferred.reject({code: -32602, message: 'Invalid params'});
        await flushPromises();
        assert.equal(harness.client.requests.length, 2);
        assert.deepEqual(harness.client.requests[1].params, {uri: document.uri.toString()});
        harness.client.requests[1].deferred.resolve(successfulResult(document));
        await flushPromises();
        const state = harness.controller.getPanelState(document.uri.toString());
        assert.equal(state?.lastSuccess?.attributeRowsAvailable, false);
        assert.match(state?.status.message ?? '', /header navigation only/i);
        harness.controller.dispose();
    });

    test('rejects attribute targets returned by the legacy header-only fallback', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/invalid-legacy-server.ttl');
        await harness.controller.openGraphicalView(document);
        harness.client.requests[0].deferred.reject({code: -32602, message: 'Invalid params'});
        await flushPromises();
        const attributeId = 'gv-attribute-0123456789abcdef';
        harness.client.requests[1].deferred.resolve({
            uri: document.uri.toString(),
            svg: `<svg><g id="${attributeId}"><text>row</text></g></svg>`,
            targets: [{
                id: attributeId,
                kind: 'attributeRow',
                ownerUrn: 'urn:samm:example.graphical:1.0.0#Aspect',
                predicateUrn: 'urn:samm:org.eclipse.esmf.samm:meta-model:2.2.0#description',
                selection: 'singleOccurrence',
                language: 'en',
            }],
            warnings: [],
        });
        await flushPromises();
        const state = harness.controller.getPanelState(document.uri.toString());
        assert.equal(state?.lastSuccess, undefined);
        assert.equal(state?.status.kind, 'stale');
        assert.equal(state?.status.reason, 'invalidResponse');
        harness.controller.dispose();
    });

    test('rejects malformed, stale, fake, extra-field, and non-sidecar navigation before LSP resolution', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/rejected-navigation.ttl');
        await harness.controller.openGraphicalView(document);
        const first = successfulResult(document, 'aaaaaaaaaaaaaaaa');
        harness.client.requests[0].deferred.resolve(first);
        await flushPromises();

        const rejectedMessages: unknown[] = [
            {type: 'navigate', targetId: first.targets[0].id},
            {type: 'navigate', version: 1, targetId: first.targets[0].id, uri: 'file:///tmp/evil.ttl'},
            {type: 'navigate', version: 1, targetId: 'gv-header-bbbbbbbbbbbbbbbb'},
            {type: 'navigate', version: 1, targetId: 'bad-marker'},
            {type: 'navigate', version: 1.5, targetId: first.targets[0].id},
            {type: 'navigate', version: '1', targetId: first.targets[0].id},
            {type: 'navigate', version: 1, targetId: first.targets[0].id, elementUrn: first.targets[0].elementUrn},
        ];
        for (const message of rejectedMessages) {
            harness.panels.panels[0].emitMessage(message);
        }

        harness.panels.panels[0].emitMessage({type: 'refresh'});
        const second = successfulResult(document, 'cccccccccccccccc');
        harness.client.requests[1].deferred.resolve(second);
        await flushPromises();
        harness.panels.panels[0].emitMessage({type: 'navigate', version: 1, targetId: first.targets[0].id});
        assert.equal(harness.client.resolveRequests.length, 0);
        assert.equal(harness.window.openedEditors.length, 0);
        harness.controller.dispose();
    });

    test('blocks warning, malformed, invalid-range, non-file, resolver-failure, and editor-open navigation paths', async () => {
        const harness = createGraphicalViewHarness();
        const document = track(harness, '/tmp/navigation-failures.ttl');
        await harness.controller.openGraphicalView(document);
        const result = successfulResult(document);
        harness.client.requests[0].deferred.resolve(result);
        await flushPromises();
        const navigate = async () => {
            harness.panels.panels[0].emitMessage({type: 'navigate', version: 1, targetId: result.targets[0].id});
            await flushPromises();
            await flushPromises();
        };

        for (const warning of ['notFound', 'ambiguous', 'unsupportedUri', 'temporarilyUnresolvable'] as const) {
            harness.client.resolveResult = {location: null, warning};
            await navigate();
        }
        harness.client.resolveResult = {
            location: {
                uri: 'https://example.invalid/model.ttl',
                range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}},
            },
        };
        await navigate();
        harness.client.resolveResult = {
            location: {
                uri: vscode.Uri.file('/tmp/invalid-range.ttl').toString(),
                range: {start: {line: 2, character: 0}, end: {line: 1, character: 0}},
            },
        };
        await navigate();
        harness.client.resolveResult = {location: null, warning: null};
        await navigate();
        harness.client.resolveFailure = new Error('hostile resolver detail');
        await navigate();
        harness.client.resolveFailure = undefined;
        harness.client.resolveResult = {
            location: {
                uri: vscode.Uri.file('/tmp/open-failure.ttl').toString(),
                range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}},
            },
        };
        harness.window.showTextDocumentFailure = new Error('hostile editor detail');
        await navigate();

        assert.equal(harness.window.openedEditors.length, 0);
        assert.equal(harness.window.warnings.length, 9);
        assert.ok(harness.window.warnings.every(message => !message.includes('hostile')));
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
