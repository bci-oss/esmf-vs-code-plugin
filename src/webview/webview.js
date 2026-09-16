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

(function () {
    'use strict';

    const MIN_ZOOM = 0.25;
    const MAX_ZOOM = 4;
    const ZOOM_FACTOR = 1.2;
    const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
    const MARKER_PATTERN = /^gv-(?:header|attribute)-[a-z0-9]{16,32}$/;
    const POSITIVE_DIMENSION_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:pt)?$/;
    const vscode = acquireVsCodeApi();
    const viewport = document.querySelector('#viewport');
    const diagram = document.querySelector('#diagram');
    const status = document.querySelector('#status');
    const statusText = document.querySelector('#status-text');
    const zoomValue = document.querySelector('#zoom-value');
    const STATUS_KINDS = Object.freeze(['loading', 'ready', 'stale', 'unsupported', 'disconnected']);
    let currentVersion = null;
    let currentSvg = null;
    let baseWidth = 0;
    let baseHeight = 0;
    let restoreGeneration = 0;
    let state = normalizeState(vscode.getState());

    function normalizeState(candidate) {
        if (!candidate || candidate.schemaVersion !== 1) {
            return {schemaVersion: 1, zoom: 1, scrollLeft: 0, scrollTop: 0};
        }
        return {
            schemaVersion: 1,
            zoom: Number.isFinite(candidate.zoom) ? clamp(candidate.zoom, MIN_ZOOM, MAX_ZOOM) : 1,
            scrollLeft: Number.isFinite(candidate.scrollLeft) ? Math.max(0, candidate.scrollLeft) : 0,
            scrollTop: Number.isFinite(candidate.scrollTop) ? Math.max(0, candidate.scrollTop) : 0,
        };
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function persistState() {
        state = {
            schemaVersion: 1,
            zoom: state.zoom,
            scrollLeft: Math.max(0, viewport.scrollLeft),
            scrollTop: Math.max(0, viewport.scrollTop),
        };
        vscode.setState(state);
        updateZoomLabel();
    }

    function updateZoomLabel() {
        zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
    }

    function updateStatus(candidate) {
        if (
            !candidate ||
            typeof candidate !== 'object' ||
            Array.isArray(candidate) ||
            !STATUS_KINDS.includes(candidate.kind) ||
            typeof candidate.message !== 'string'
        ) {
            return;
        }
        status.setAttribute('data-kind', candidate.kind);
        status.setAttribute('title', candidate.message);
        statusText.textContent = candidate.message;
    }

    function captureViewport() {
        state = {...state, scrollLeft: Math.max(0, viewport.scrollLeft), scrollTop: Math.max(0, viewport.scrollTop)};
    }

    function dimensions(svg) {
        const width = parseDimension(svg.getAttribute('width'));
        const height = parseDimension(svg.getAttribute('height'));
        if (width === undefined || height === undefined) {
            throw new Error('SVG dimensions are unavailable');
        }
        return {width, height};
    }

    function parseDimension(value) {
        if (typeof value !== 'string' || !POSITIVE_DIMENSION_PATTERN.test(value)) {
            return undefined;
        }
        const parsed = Number(value.endsWith('pt') ? value.slice(0, -2) : value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }

    function parseTrustedSvg(svgText) {
        const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        if (parsed.getElementsByTagName('parsererror').length > 0) {
            throw new Error('SVG is not well-formed XML');
        }
        const svg = parsed.documentElement;
        if (!svg || svg.localName !== 'svg' || svg.namespaceURI !== SVG_NAMESPACE) {
            throw new Error('SVG document root is invalid');
        }
        dimensions(svg);
        const imported = document.importNode(svg, true);
        if (!(imported instanceof Element) || imported.localName !== 'svg' || imported.namespaceURI !== SVG_NAMESPACE) {
            throw new Error('SVG document root could not be imported');
        }
        return imported;
    }

    function applyZoom() {
        if (!currentSvg) {
            updateZoomLabel();
            return;
        }
        currentSvg.setAttribute('width', String(baseWidth * state.zoom));
        currentSvg.setAttribute('height', String(baseHeight * state.zoom));
        updateZoomLabel();
    }

    function restoreViewport(version, notifyRendered) {
        const generation = ++restoreGeneration;
        afterLayout(() => {
            if (generation !== restoreGeneration || version !== currentVersion) {
                return;
            }
            const maximumLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
            const maximumTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
            viewport.scrollLeft = Math.min(state.scrollLeft, maximumLeft);
            viewport.scrollTop = Math.min(state.scrollTop, maximumTop);
            persistState();
            if (notifyRendered) {
                vscode.postMessage({type: 'rendered', version});
            }
        });
    }

    function afterLayout(callback) {
        let completed = false;
        const complete = () => {
            if (!completed) {
                completed = true;
                callback();
            }
        };
        requestAnimationFrame(() => requestAnimationFrame(complete));
        setTimeout(complete, 100);
    }

    function setZoom(zoom) {
        captureViewport();
        state = {...state, zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM)};
        applyZoom();
        restoreViewport(currentVersion, false);
    }

    function fitDiagram() {
        if (!currentSvg || baseWidth <= 0 || baseHeight <= 0) {
            return;
        }
        const availableWidth = Math.max(1, viewport.clientWidth - 24);
        const availableHeight = Math.max(1, viewport.clientHeight - 24);
        setZoom(Math.min(availableWidth / baseWidth, availableHeight / baseHeight));
        state = {...state, scrollLeft: 0, scrollTop: 0};
        restoreViewport(currentVersion, false);
    }

    function isExactMessage(message, keys) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            return false;
        }
        const actualKeys = Object.keys(message).sort();
        return actualKeys.length === keys.length && actualKeys.every((key, index) => key === keys[index]);
    }

    function render(message) {
        if (
            !isExactMessage(message, ['svg', 'type', 'version']) ||
            message.type !== 'render' ||
            !Number.isInteger(message.version) ||
            message.version < 1 ||
            typeof message.svg !== 'string'
        ) {
            return;
        }

        try {
            if (currentSvg) {
                captureViewport();
            }
            const parsedSvg = parseTrustedSvg(message.svg);
            const size = dimensions(parsedSvg);
            makeNavigationMarkersInteractive(parsedSvg);
            diagram.replaceChildren(parsedSvg);
            currentSvg = parsedSvg;
            currentVersion = message.version;
            baseWidth = size.width;
            baseHeight = size.height;
            applyZoom();
            restoreViewport(currentVersion, true);
        } catch (error) {
            updateStatus({
                kind: 'stale',
                message: 'The new diagram is not a usable SVG document. The last valid diagram is retained.',
            });
            vscode.postMessage({type: 'renderError', version: message.version, reason: 'xmlParsingFailed'});
        }
    }

    viewport.addEventListener('scroll', persistState, {passive: true});
    diagram.addEventListener('click', event => {
        activateNavigationTarget(event.target);
    });
    diagram.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        if (activateNavigationTarget(event.target)) {
            event.preventDefault();
        }
    });

    function makeNavigationMarkersInteractive(svg) {
        for (const group of svg.querySelectorAll('g[id]')) {
            if (MARKER_PATTERN.test(group.id)) {
                group.setAttribute('tabindex', '0');
                group.setAttribute('role', 'link');
                group.setAttribute('aria-label', group.id.startsWith('gv-attribute-')
                    ? 'Navigate to attribute source statement'
                    : 'Navigate to element definition');
            }
        }
    }

    function activateNavigationTarget(target) {
        const group = target instanceof Element ? target.closest('g[id]') : null;
        if (!group || !diagram.contains(group) || !MARKER_PATTERN.test(group.id) || !Number.isInteger(currentVersion)) {
            return false;
        }
        vscode.postMessage({type: 'navigate', version: currentVersion, targetId: group.id});
        return true;
    }

    document.querySelector('#refresh').addEventListener('click', () => vscode.postMessage({type: 'refresh'}));
    document.querySelector('#zoom-in').addEventListener('click', () => setZoom(state.zoom * ZOOM_FACTOR));
    document.querySelector('#zoom-out').addEventListener('click', () => setZoom(state.zoom / ZOOM_FACTOR));
    document.querySelector('#zoom-reset').addEventListener('click', () => setZoom(1));
    document.querySelector('#zoom-fit').addEventListener('click', fitDiagram);

    window.addEventListener('message', event => {
        const message = event.data;
        if (message?.type === 'render') {
            render(message);
            return;
        }
        if (
            isExactMessage(message, ['status', 'type']) &&
            message.type === 'status' &&
            message.status &&
            typeof message.status === 'object'
        ) {
            updateStatus(message.status);
        }
    });

    updateZoomLabel();
    vscode.setState(state);
    vscode.postMessage({type: 'ready'});
})();
