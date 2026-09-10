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
import {ChildProcessWithoutNullStreams} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {Readable, Writable} from 'node:stream';
import * as vscode from 'vscode';
import type {ServerExitEvent} from '../languageServicesSupervisor';
import {TurtleLanguageServer} from '../languageServer';
import type {ExtensionLogger} from '../outputChannel';

class FakeChild extends EventEmitter {
    readonly pid = 4242;
    readonly stdout = new Readable({read: () => undefined});
    readonly stderr = new Readable({read: () => undefined});
    readonly stdin = new Writable({write: (_chunk, _encoding, callback) => callback()});
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killCount = 0;

    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        this.killCount++;
        this.emitExit(null, signal);
        return true;
    }

    emitExit(code: number | null, signal: NodeJS.Signals | null): void {
        this.exitCode = code;
        this.signalCode = signal;
        this.emit('exit', code, signal);
    }
}

class TestLanguageServer extends TurtleLanguageServer {
    constructor(
        private readonly child: FakeChild,
        private readonly readiness: (child: FakeChild) => Promise<void> = async () => undefined,
    ) {
        const logger: ExtensionLogger = {
            trace: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        };
        super({extensionPath: '/tmp/test-extension'} as vscode.ExtensionContext, logger, '/tmp/test-samm-cli', 19461);
    }

    protected override createChildProcess(): ChildProcessWithoutNullStreams {
        return this.child as unknown as ChildProcessWithoutNullStreams;
    }

    protected override waitForServerPort(): Promise<void> {
        return this.readiness(this.child);
    }
}

suite('TurtleLanguageServer lifecycle', () => {
    test('reports one immutable unexpected post-ready exit with metadata', async () => {
        const child = new FakeChild();
        const server = new TestLanguageServer(child);
        const events: ServerExitEvent[] = [];
        server.onExit(event => events.push(event));
        await server.start();

        child.emitExit(134, 'SIGABRT');
        child.emitExit(134, 'SIGABRT');

        assert.strictEqual(events.length, 1);
        assert.deepStrictEqual(events[0], {pid: 4242, code: 134, signal: 'SIGABRT', expected: false});
        assert.ok(Object.isFrozen(events[0]));
        assert.strictEqual(server.pid, undefined);
    });

    test('coalesces spawn error and later exit into one event', async () => {
        const child = new FakeChild();
        const server = new TestLanguageServer(child);
        const events: ServerExitEvent[] = [];
        server.onExit(event => events.push(event));
        await server.start();

        child.emit('error', new Error('spawn failed'));
        child.emitExit(1, null);

        assert.deepStrictEqual(events, [{pid: 4242, code: null, signal: null, expected: false}]);
    });

    test('fails immediately when the child exits during readiness', async () => {
        const child = new FakeChild();
        const server = new TestLanguageServer(child, async current => {
            current.emitExit(1, null);
            throw new Error('The Turtle language server exited before it became ready.');
        });

        await assert.rejects(server.start(), /exited before it became ready/);
        assert.strictEqual(server.pid, undefined);
        assert.strictEqual(child.killCount, 0);
    });

    test('marks timeout cleanup expected and stop remains idempotent', async () => {
        const child = new FakeChild();
        const server = new TestLanguageServer(child, async () => {
            throw new Error('Timed out waiting for the Turtle language server to start on port 19461.');
        });
        const events: ServerExitEvent[] = [];
        server.onExit(event => events.push(event));

        await assert.rejects(server.start(), /Timed out/);
        await server.stop();

        assert.strictEqual(child.killCount, 1);
        assert.deepStrictEqual(events, [{pid: 4242, code: null, signal: 'SIGTERM', expected: true}]);
    });
});
