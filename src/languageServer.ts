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
import {ChildProcessWithoutNullStreams, spawn} from 'node:child_process';
import * as net from 'node:net';
import type {ExtensionLogger} from './outputChannel';
import {JAVA_OPTIONS} from './constants';
import type {DisposableLike, ServerExitEvent} from './languageServicesSupervisor';

const SERVER_READY_TIMEOUT_MS = 60_000;
const SERVER_READY_RETRY_DELAY_MS = 250;

export class TurtleLanguageServer {
    private serverProcess: ChildProcessWithoutNullStreams | undefined;
    private readonly exitListeners = new Set<(event: ServerExitEvent) => void>();
    private readonly expectedProcesses = new WeakSet<ChildProcessWithoutNullStreams>();
    private readonly reportedProcesses = new WeakSet<ChildProcessWithoutNullStreams>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly outputChannel: ExtensionLogger,
        private readonly sammCliExecutablePath: string,
        private readonly serverPort: number,
    ) {}

    get pid(): number | undefined {
        return this.serverProcess?.pid;
    }

    onExit(listener: (event: ServerExitEvent) => void): DisposableLike {
        this.exitListeners.add(listener);
        return {dispose: () => this.exitListeners.delete(listener)};
    }

    async start(): Promise<void> {
        const [executable, args] = this.sammCliExecutablePath.endsWith('.jar')
            ? ['java', [...JAVA_OPTIONS, '-jar', this.sammCliExecutablePath, 'lsp', '--port', String(this.serverPort)]]
            : [this.sammCliExecutablePath, ['lsp', '--port', String(this.serverPort)]];

        this.serverProcess = this.spawnProcess(executable, args);
        this.outputChannel.info(
            `[language-server] event=spawned mode=${this.sammCliExecutablePath.endsWith('.jar') ? 'jar' : 'native'} port=${this.serverPort} pid=${String(this.serverProcess.pid)}`,
        );

        try {
            await this.waitForServerPort(this.serverPort, this.serverProcess);
        } catch (error) {
            await this.stop();
            throw error;
        }
        this.outputChannel.info('Language server started successfully.');
    }

    async stop(): Promise<void> {
        const process = this.serverProcess;
        if (!process) {
            return;
        }
        this.expectedProcesses.add(process);
        this.serverProcess = undefined;

        if (process.exitCode !== null || process.signalCode !== null) {
            return;
        }

        await new Promise<void>(resolve => {
            const fallback = setTimeout(() => {
                try {
                    process.kill('SIGKILL');
                } catch {
                    // The process may already have exited.
                }
                resolve();
            }, 3000);

            process.once('exit', () => {
                clearTimeout(fallback);
                resolve();
            });

            try {
                process.kill();
            } catch {
                clearTimeout(fallback);
                resolve();
            }
        });
    }

    private spawnProcess(executable: string, args: string[]): ChildProcessWithoutNullStreams {
        const child = this.createChildProcess(executable, args);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', data => {
            this.outputChannel.trace(String(data).trimEnd());
        });

        child.stderr.on('data', data => {
            this.outputChannel.warn(`[server stderr] ${String(data).trimEnd()}`);
        });

        child.once('error', error => {
            this.outputChannel.error(`Server process error: ${String(error instanceof Error ? error.message : error)}`);
            this.reportExit(child, null, null);
        });
        child.once('exit', (code, signal) => this.reportExit(child, code, signal));

        return child;
    }

    protected createChildProcess(executable: string, args: string[]): ChildProcessWithoutNullStreams {
        const spawnOptions = {
            cwd: this.context.extensionPath,
            env: process.env,
            stdio: 'pipe' as const,
        };

        return spawn(executable, args, spawnOptions) as ChildProcessWithoutNullStreams;
    }

    protected async waitForServerPort(port: number, process: ChildProcessWithoutNullStreams): Promise<void> {
        const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;

        while (Date.now() < deadline) {
            if (this.serverProcess !== process || process.exitCode !== null || process.signalCode !== null) {
                throw new Error('The Turtle language server exited before it became ready.');
            }
            if (await this.isServerListening(port, process)) {
                return;
            }

            await this.delay(SERVER_READY_RETRY_DELAY_MS);
        }

        throw new Error(`Timed out waiting for the Turtle language server to start on port ${port}.`);
    }

    private async isServerListening(port: number, process: ChildProcessWithoutNullStreams): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            let settled = false;

            const finish = (callback: () => void): void => {
                if (settled) {
                    return;
                }

                settled = true;
                process.removeListener('exit', exitListener);
                callback();
            };

            const exitListener = (): void => {
                finish(() => reject(new Error('The Turtle language server exited before it became ready.')));
            };

            process.once('exit', exitListener);

            const socket = net.connect({host: '127.0.0.1', port}, () => {
                finish(() => {
                    socket.end();
                    resolve(true);
                });
            });

            socket.once('error', () => {
                finish(() => {
                    socket.destroy();
                    resolve(false);
                });
            });
        });
    }

    private delay(milliseconds: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    private reportExit(process: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
        if (this.reportedProcesses.has(process)) {
            return;
        }
        this.reportedProcesses.add(process);
        if (this.serverProcess === process) {
            this.serverProcess = undefined;
        }
        const event: ServerExitEvent = Object.freeze({
            pid: process.pid,
            code,
            signal,
            expected: this.expectedProcesses.has(process),
        });
        this.exitListeners.forEach(listener => listener(event));
    }
}
