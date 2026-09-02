/*
 * Copyright (c) 2026 Robert Bosch Manufacturing Solutions GmbH
 * SPDX-License-Identifier: MPL-2.0
 */

import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';

suite('Graphical View webview controller', () => {
    test('posts only current ID-only navigation for pointer and Enter/Space activation', () => {
        const source = readFileSync(join(__dirname, '..', '..', 'src', 'webview', 'webview.js'), 'utf8');
        const posted: unknown[] = [];
        let currentMarker: FakeElement | undefined;
        const diagram = new FakeElement();
        const viewport = new FakeElement();
        viewport.clientWidth = 1000;
        viewport.clientHeight = 800;
        viewport.scrollWidth = 2200;
        viewport.scrollHeight = 1600;
        diagram.contains = candidate => candidate === currentMarker;
        diagram.replaceChildren = fragment => {
            currentMarker = (fragment as {marker: FakeElement}).marker;
        };

        const elements = new Map<string, FakeElement>([
            ['#diagram', diagram],
            ['#viewport', viewport],
            ['#status', new FakeElement()],
            ['#zoom-value', new FakeElement()],
            ['#refresh', new FakeElement()],
            ['#zoom-in', new FakeElement()],
            ['#zoom-out', new FakeElement()],
            ['#zoom-reset', new FakeElement()],
            ['#zoom-fit', new FakeElement()],
        ]);
        const window = new FakeElement();
        const state: {value?: unknown} = {};
        const context = {
            acquireVsCodeApi: () => ({
                getState: () => undefined,
                setState: (value: unknown) => {
                    state.value = value;
                },
                postMessage: (message: unknown) => posted.push(message),
            }),
            document: {querySelector: (selector: string) => elements.get(selector)},
            window,
            Element: FakeElement,
            SanitizerContract: {
                MARKER_PATTERN: /^gv-(?:header|attribute)-[a-z0-9]{16,32}$/,
                sanitizeSvg: (svgText: string) => {
                    const id = svgText.match(/gv-(?:header|attribute)-[a-z0-9]{16,32}/)?.[0];
                    assert.ok(id);
                    const marker = new FakeElement(id);
                    const svg = new FakeSvg(marker);
                    return {fragment: {marker}, svg};
                },
            },
            requestAnimationFrame: (callback: () => void) => callback(),
            setTimeout: (callback: () => void) => {
                callback();
                return 0;
            },
            Number,
            Object,
            Math,
            Error,
        };
        runInNewContext(source, context);

        const markerId = 'gv-attribute-aaaaaaaaaaaaaaaa';
        window.fire('message', {data: {type: 'render', version: 4, svg: `<svg><g id="${markerId}"/></svg>`}});
        assert.ok(currentMarker);
        assert.equal(currentMarker.attributes.get('tabindex'), '0');
        assert.equal(currentMarker.attributes.get('role'), 'link');

        diagram.fire('click', {target: currentMarker});
        let prevented = 0;
        diagram.fire('keydown', {target: currentMarker, key: 'Enter', preventDefault: () => prevented++});
        diagram.fire('keydown', {target: currentMarker, key: ' ', preventDefault: () => prevented++});
        diagram.fire('keydown', {target: currentMarker, key: 'Escape', preventDefault: () => prevented++});

        assert.deepEqual(JSON.parse(JSON.stringify(posted.filter(isNavigateMessage))), [
            {type: 'navigate', version: 4, targetId: markerId},
            {type: 'navigate', version: 4, targetId: markerId},
            {type: 'navigate', version: 4, targetId: markerId},
        ]);
        assert.equal(prevented, 2);
        assert.deepEqual(JSON.parse(JSON.stringify(state.value)), {schemaVersion: 1, zoom: 1, scrollLeft: 0, scrollTop: 0});
    });
});

class FakeElement {
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, (event: never) => void>();
    textContent = '';
    scrollLeft = 0;
    scrollTop = 0;
    scrollWidth = 0;
    scrollHeight = 0;
    clientWidth = 0;
    clientHeight = 0;
    contains: (candidate: unknown) => boolean = () => false;
    replaceChildren: (fragment: unknown) => void = () => undefined;

    constructor(readonly id = '') {}

    addEventListener(type: string, listener: (event: never) => void): void {
        this.listeners.set(type, listener);
    }

    fire(type: string, event: unknown): void {
        this.listeners.get(type)?.(event as never);
    }

    closest(): FakeElement {
        return this;
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }
}

class FakeSvg extends FakeElement {
    readonly viewBox = {baseVal: {width: 2200, height: 1600}};

    constructor(private readonly marker: FakeElement) {
        super();
    }

    getAttribute(name: string): string | null {
        return name === 'width' ? '2200' : name === 'height' ? '1600' : null;
    }

    querySelectorAll(): FakeElement[] {
        return [this.marker];
    }
}

function isNavigateMessage(value: unknown): value is {type: 'navigate'; version: number; targetId: string} {
    return typeof value === 'object' && value !== null && (value as {type?: unknown}).type === 'navigate';
}
