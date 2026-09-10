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

import * as assert from 'assert';
import {CloseAction, State} from 'vscode-languageclient/node';
import {createDoNotRestartErrorHandler, TurtleLanguageClient} from '../languageClient';

suite('TurtleLanguageClient lifecycle', () => {
    test('uses DoNotRestart and reports a duplicate close only once', async () => {
        let closeCount = 0;
        const handler = createDoNotRestartErrorHandler(() => closeCount++);

        const first = await handler.closed();
        const second = await handler.closed();

        assert.strictEqual(first.action, CloseAction.DoNotRestart);
        assert.strictEqual(second.action, CloseAction.DoNotRestart);
        assert.strictEqual(closeCount, 1);
    });

    test('disconnect is idempotent after the client reaches Stopped', async () => {
        let stopCount = 0;
        const client = {
            state: State.Running,
            stop: async () => {
                stopCount++;
                client.state = State.Stopped;
            },
        };
        const wrapper = Object.create(TurtleLanguageClient.prototype) as unknown as {
            client: typeof client;
            disconnecting: boolean;
            disconnect(): Promise<void>;
        };
        wrapper.client = client;
        wrapper.disconnecting = false;

        await wrapper.disconnect();
        await wrapper.disconnect();

        assert.strictEqual(stopCount, 1);
    });
});
