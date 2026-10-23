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
        let resolveRequest: ((value: 'validation_successful') => void) | undefined;
        const request = new Promise<'validation_successful'>(resolve => (resolveRequest = resolve));
        const harness = createValidationControllerHarness({request: async <R>() => request as Promise<R>});
        const validation = harness.controller.validateDocument(createValidationDocument('/tmp/model.ttl'), 'manual');

        harness.controller.setClient({sendRequest: async <R>() => ('validation_successful') as R}, 2);
        resolveRequest?.('validation_successful');

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

        harness.controller.setClient({sendRequest: async <R>() => ('validation_successful') as R}, 2);
        rejectRequest?.(new Error('old connection failed'));

        assert.strictEqual(await validation, undefined);
        assert.deepStrictEqual(harness.window.errorMessages, []);
        assert.ok(harness.outputChannel.lines.some(line => line.includes('Ignoring stale failure')));
    });

    test('reports the current successful request', async () => {
        const harness = createValidationControllerHarness({response: 'validation_successful'});
        const result = await harness.controller.validateDocument(createValidationDocument('/tmp/model.ttl'), 'manual');

        assert.deepStrictEqual(result, 'validation_successful');
        assert.deepStrictEqual(harness.window.infoMessages, ['Aspect validation completed without issues.']);
        assert.strictEqual(harness.sentRequests[0].method, VALIDATE_DOCUMENT_REQUEST);
    });

    test('reports an Error result and points to the Problems view on manual validation', async () => {
        const harness = createValidationControllerHarness({response: 'validation_failed'});
        const result = await harness.controller.validateDocument(createValidationDocument('/tmp/model.ttl'), 'manual');

        assert.strictEqual(result, 'Error');
        assert.deepStrictEqual(harness.window.errorMessages, ['Aspect validation failed. See the Problems view for details.']);
        assert.deepStrictEqual(harness.window.infoMessages, []);
    });

    test('shows the summary in the status bar on save-triggered validation', async () => {
        const success = createValidationControllerHarness({response: 'validation_successful'});
        await success.controller.validateDocument(createValidationDocument('/tmp/model.ttl'), 'save');
        assert.ok(success.window.statusMessages.includes('Aspect validation completed without issues.'));
        assert.deepStrictEqual(success.window.infoMessages, []);

        const failure = createValidationControllerHarness({response: 'validation_failed'});
        await failure.controller.validateDocument(createValidationDocument('/tmp/model.ttl'), 'save');
        assert.ok(failure.window.statusMessages.includes('Aspect validation failed. See the Problems view for details.'));
        assert.deepStrictEqual(failure.window.errorMessages, []);
    });

    test('reports the current failed request', async () => {
        const harness = createValidationControllerHarness({error: new Error('connection failed')});
        const result = await harness.controller.validateDocument(createValidationDocument('/tmp/model.ttl'), 'manual');

        assert.strictEqual(result, undefined);
        assert.deepStrictEqual(harness.window.errorMessages, ['Aspect validation request failed: connection failed']);
    });

    test('does not validate documents with an unsupported scheme', async () => {
        const harness = createValidationControllerHarness({response: 'validation_successful'});
        const virtualDoc = createValidationDocument(vscode.Uri.parse('chat-editing-text-model:/tmp/Model.ttl'));

        const result = await harness.controller.validateDocument(virtualDoc, 'manual');

        assert.strictEqual(result, undefined);
        assert.strictEqual(harness.sentRequests.length, 0);
        assert.strictEqual(harness.window.warningMessages.length, 1);
        assert.deepStrictEqual(harness.window.warningMessages, ['Open a Turtle file before running aspect validation.']);
    });

    test('validates untitled documents', async () => {
        const harness = createValidationControllerHarness({response: 'validation_successful'});
        const untitledDoc = createValidationDocument(vscode.Uri.parse('untitled:Untitled-1'));

        const result = await harness.controller.validateDocument(untitledDoc, 'manual');

        assert.deepStrictEqual(result, 'validation_successful');
        assert.strictEqual(harness.sentRequests.length, 1);
    });

    test('register remains compatible with the VS Code command surface', async () => {
        await withStubbedRegisterCommand(() => {
            const harness = createValidationControllerHarness();
            harness.controller.register({subscriptions: []} as unknown as vscode.ExtensionContext);
        });
    });
});
