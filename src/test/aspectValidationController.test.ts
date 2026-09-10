// Copyright (c) 2026 Robert Bosch Manufacturing Solutions GmbH
//
// See the AUTHORS file(s) distributed with this work for additional
// information regarding authorship.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https:gmozilla.org/MPL/2.0/.
//
// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import * as vscode from 'vscode';
import {AspectValidationController, VALIDATE_DOCUMENT_REQUEST} from '../aspectValidation';
import {createValidationControllerHarness, createValidationDocument} from './validationTestHarness';

async function withStubbedRegisterCommand(run: () => void | Promise<void>): Promise<void> {
    const originalRegisterCommand = vscode.commands.registerCommand;

    Object.assign(vscode.commands, {
        registerCommand: () => new vscode.Disposable(() => undefined),
    });

    try {
        await run();
    } finally {
        Object.assign(vscode.commands, {
            registerCommand: originalRegisterCommand,
        });
    }
}

suite('AspectValidationController', () => {
    test('ignores a stale successful request after client replacement', async () => {
        let resolveRequest: ((value: {diagnostics: []}) => void) | undefined;
        const request = new Promise<{diagnostics: []}>(resolve => (resolveRequest = resolve));
        const harness = createValidationControllerHarness({request: async <R>() => request as Promise<R>});
        const validation = harness.controller.validateDocument(createValidationDocument('/tmp/model.ttl'), 'manual');

        harness.controller.setClient({sendRequest: async <R>() => ({diagnostics: []}) as R}, 2);
        resolveRequest?.({diagnostics: []});

        assert.strictEqual(await validation, undefined);
        assert.deepStrictEqual(harness.window.infoMessages, []);
        assert.deepStrictEqual(harness.window.errorMessages, []);
        assert.ok(harness.outputChannel.lines.some(line => line.includes('Ignoring stale result')));
    });

    test('ignores a stale failed request after client replacement', async () => {
        let rejectRequest: ((error: Error) => void) | undefined;
        const request = new Promise<never>((_, reject) => (rejectRequest = reject));
        const harness = createValidationControllerHarness({request: async <R>() => request as Promise<R>});
        const validation = harness.controller.validateDocument(createValidationDocument('/tmp/model.ttl'), 'manual');

        harness.controller.setClient({sendRequest: async <R>() => ({diagnostics: []}) as R}, 2);
        rejectRequest?.(new Error('old connection failed'));

        assert.strictEqual(await validation, undefined);
        assert.deepStrictEqual(harness.window.errorMessages, []);
        assert.ok(harness.outputChannel.lines.some(line => line.includes('Ignoring stale failure')));
    });

    test('reports the current successful request', async () => {
        const harness = createValidationControllerHarness({response: {diagnostics: []}});
        const result = await harness.controller.validateDocument(createValidationDocument('/tmp/model.ttl'), 'manual');

        assert.deepStrictEqual(result, {diagnostics: []});
        assert.deepStrictEqual(harness.window.infoMessages, ['Aspect validation completed without issues.']);
        assert.strictEqual(harness.sentRequests[0].method, VALIDATE_DOCUMENT_REQUEST);
    });

    test('reports the current failed request', async () => {
        const harness = createValidationControllerHarness({error: new Error('connection failed')});
        const result = await harness.controller.validateDocument(createValidationDocument('/tmp/model.ttl'), 'manual');

        assert.strictEqual(result, undefined);
        assert.deepStrictEqual(harness.window.errorMessages, ['Aspect validation request failed: connection failed']);
    });

    test('uses status messages rather than notifications for save validation', async () => {
        await withStubbedRegisterCommand(async () => {
            const harness = createValidationControllerHarness({response: {diagnostics: []}});
            harness.controller.register({subscriptions: []} as unknown as vscode.ExtensionContext);

            await harness.workspace.fireSave(createValidationDocument('/tmp/model.ttl'));
            for (let index = 0; index < 8; index++) {
                await Promise.resolve();
            }

            assert.deepStrictEqual(harness.window.statusMessages, [
                'Aspect model validation in progress...',
                'Aspect validation completed without issues.',
            ]);
            assert.deepStrictEqual(harness.window.infoMessages, []);
            assert.deepStrictEqual(harness.window.errorMessages, []);
        });
    });

    test('register remains compatible with the VS Code command surface', async () => {
        await withStubbedRegisterCommand(() => {
            const harness = createValidationControllerHarness();
            harness.controller.register({subscriptions: []} as unknown as vscode.ExtensionContext);
        });
    });
});
