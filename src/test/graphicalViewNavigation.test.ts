/*
 * Copyright (c) 2026 Robert Bosch Manufacturing Solutions GmbH
 * SPDX-License-Identifier: MPL-2.0
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {resolveGraphicalViewNavigation, validateGraphicalViewResolveResult} from '../graphicalViewNavigation';
import type {GraphicalViewRenderResult} from '../graphicalViewProtocol';
import {
    createGraphicalViewDocument,
    createGraphicalViewHarness,
    flushPromises,
    openGraphicalView,
} from './graphicalViewTestHarness';

const OWNER = 'urn:samm:example.graphical:1.0.0#Aspect';
const PREDICATE = 'urn:samm:org.eclipse.esmf.samm:meta-model:2.2.0#description';

suite('Graphical View source navigation', () => {
    test('dispatches trusted element and language-qualified attribute locators to distinct LSP methods', async () => {
        const harness = createGraphicalViewHarness();
        const cancellation = new vscode.CancellationTokenSource();
        harness.client.resolveResult = {location: null, warning: 'notFound'};

        await resolveGraphicalViewNavigation(
            harness.client,
            'file:///tmp/source.ttl',
            {id: 'gv-header-aaaaaaaaaaaaaaaa', kind: 'elementHeader', elementUrn: OWNER},
            cancellation.token,
        );
        await resolveGraphicalViewNavigation(
            harness.client,
            'file:///tmp/source.ttl',
            {
                id: 'gv-attribute-bbbbbbbbbbbbbbbb',
                kind: 'attributeRow',
                ownerUrn: OWNER,
                predicateUrn: PREDICATE,
                selection: 'singleOccurrence',
                language: 'de',
            },
            cancellation.token,
        );

        assert.deepEqual(harness.client.resolveRequests[0].params, {
            sourceUri: 'file:///tmp/source.ttl',
            elementUrn: OWNER,
        });
        assert.deepEqual(harness.client.attributeResolveRequests[0].params, {
            sourceUri: 'file:///tmp/source.ttl',
            ownerUrn: OWNER,
            predicateUrn: PREDICATE,
            selection: 'singleOccurrence',
            language: 'de',
        });
        cancellation.dispose();
        harness.controller.dispose();
    });

    test('validates local file locations and rejects invalid ranges, remote URIs, and ambiguous result shapes', () => {
        const valid = validateGraphicalViewResolveResult({
            location: {
                uri: vscode.Uri.file('/tmp/target.ttl').toString(),
                range: {start: {line: 3, character: 4}, end: {line: 5, character: 6}},
            },
        });
        assert.equal(valid.kind, 'location');
        assert.deepEqual(valid.kind === 'location' && valid.range, new vscode.Range(3, 4, 5, 6));

        const invalid = [
            {location: {uri: 'https://example.invalid/model.ttl', range: positions(0, 0, 0, 1)}},
            {location: {uri: vscode.Uri.file('/tmp/model.ttl').toString(), range: positions(2, 0, 1, 0)}},
            {location: null, warning: null},
            {location: {uri: vscode.Uri.file('/tmp/model.ttl').toString(), range: positions(0, 0, 0, 1)}, warning: 'notFound'},
            {location: null, warning: 'unknown'},
        ];
        assert.ok(invalid.every(candidate => validateGraphicalViewResolveResult(candidate).kind === 'warning'));
    });

    test('opens current multilingual and wrapped attribute targets using only the accepted sidecar', async () => {
        const harness = createGraphicalViewHarness();
        const document = createGraphicalViewDocument('/tmp/navigation.ttl');
        harness.workspace.available.add(document.uri.toString());
        await openGraphicalView(harness, document);
        const ids = [
            'gv-attribute-aaaaaaaaaaaaaaaa',
            'gv-attribute-bbbbbbbbbbbbbbbb',
            'gv-attribute-cccccccccccccccc',
        ];
        const result: GraphicalViewRenderResult = {
            uri: document.uri.toString(),
            svg: `<svg>${ids.map(id => `<g id="${id}"><text>row</text></g>`).join('')}</svg>`,
            targets: [
                {id: ids[0], kind: 'attributeRow', ownerUrn: OWNER, predicateUrn: PREDICATE, selection: 'singleOccurrence', language: 'de'},
                {id: ids[1], kind: 'attributeRow', ownerUrn: OWNER, predicateUrn: PREDICATE, selection: 'singleOccurrence', language: 'en'},
                {id: ids[2], kind: 'attributeRow', ownerUrn: OWNER, predicateUrn: PREDICATE, selection: 'predicateStart'},
            ],
            warnings: [],
        };
        harness.client.requests[0].deferred.resolve(result);
        await flushPromises();
        harness.client.resolveResult = {
            location: {uri: document.uri.toString(), range: positions(8, 3, 8, 11)},
        };

        for (const id of ids) {
            harness.panels.panels[0].emitMessage({type: 'navigate', version: 1, targetId: id});
            await flushPromises();
            await flushPromises();
        }

        assert.deepEqual(harness.client.attributeResolveRequests.map(request => request.params.language), ['de', 'en', undefined]);
        assert.deepEqual(harness.client.attributeResolveRequests.map(request => request.params.selection), [
            'singleOccurrence',
            'singleOccurrence',
            'predicateStart',
        ]);
        assert.equal(harness.window.openedEditors.length, 3);
        assert.ok(harness.window.openedEditors.every(opened => opened.editor.selection.isEqual(new vscode.Selection(8, 3, 8, 11))));
        harness.controller.dispose();
    });

    test('rejects stale, fake, malformed, extra-field, warning, non-file, and editor-open paths', async () => {
        const harness = createGraphicalViewHarness();
        const document = createGraphicalViewDocument('/tmp/rejected.ttl');
        harness.workspace.available.add(document.uri.toString());
        await openGraphicalView(harness, document);
        const id = 'gv-header-aaaaaaaaaaaaaaaa';
        harness.client.requests[0].deferred.resolve({
            uri: document.uri.toString(),
            svg: `<svg><g id="${id}"/></svg>`,
            targets: [{id, kind: 'elementHeader', elementUrn: OWNER}],
            warnings: [],
        });
        await flushPromises();

        for (const message of [
            {type: 'navigate', targetId: id},
            {type: 'navigate', version: 2, targetId: id},
            {type: 'navigate', version: 1, targetId: 'gv-header-bbbbbbbbbbbbbbbb'},
            {type: 'navigate', version: 1, targetId: id, elementUrn: OWNER},
        ]) {
            harness.panels.panels[0].emitMessage(message);
        }
        assert.equal(harness.client.resolveRequests.length, 0);

        harness.client.resolveResult = {location: null, warning: 'ambiguous'};
        harness.panels.panels[0].emitMessage({type: 'navigate', version: 1, targetId: id});
        await flushPromises();
        harness.client.resolveResult = {location: {uri: 'https://example.invalid/model.ttl', range: positions(0, 0, 0, 1)}};
        harness.panels.panels[0].emitMessage({type: 'navigate', version: 1, targetId: id});
        await flushPromises();
        harness.client.resolveResult = {location: {uri: document.uri.toString(), range: positions(0, 0, 0, 1)}};
        harness.window.showTextDocumentFailure = new Error('hostile detail');
        harness.panels.panels[0].emitMessage({type: 'navigate', version: 1, targetId: id});
        await flushPromises();
        await flushPromises();

        assert.equal(harness.window.openedEditors.length, 0);
        assert.equal(harness.window.warnings.length, 3);
        assert.ok(harness.window.warnings.every(message => !message.includes('hostile')));
        harness.controller.dispose();
    });
});

function positions(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    return {
        start: {line: startLine, character: startCharacter},
        end: {line: endLine, character: endCharacter},
    };
}
