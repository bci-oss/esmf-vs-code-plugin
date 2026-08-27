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

    const ALLOWED_TAGS = Object.freeze(['svg', 'g', 'path', 'polygon', 'text', 'title']);
    const TAG_ATTRIBUTES = Object.freeze({
        svg: new Set(['xmlns', 'height', 'width', 'viewBox']),
        g: new Set(['id', 'transform']),
        path: new Set(['d', 'fill', 'stroke']),
        polygon: new Set(['points', 'fill', 'stroke', 'stroke-width', 'cx', 'cy', 'rx', 'ry']),
        text: new Set(['x', 'y', 'fill', 'font-family', 'font-size', 'text-anchor']),
        title: new Set(),
    });
    const ALLOWED_ATTRIBUTES = Object.freeze(
        Array.from(new Set(Object.values(TAG_ATTRIBUTES).flatMap(attributes => Array.from(attributes)))),
    );
    const MARKER_PATTERN = /^gv-(?:header|attribute)-[a-z0-9]{16,32}$/;
    const COLOR_PATTERN = /^(?:none|#[0-9a-f]{6})$/i;
    const FONT_FAMILIES = new Set(['Arial', 'Roboto Condensed']);
    const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
    const NUMBER_PATTERN = new RegExp(`^${NUMBER}$`);
    const LENGTH_PATTERN = new RegExp(`^${NUMBER}(?:pt)?$`);
    const VIEW_BOX_PATTERN = new RegExp(`^${NUMBER}\\s+${NUMBER}\\s+${NUMBER}\\s+${NUMBER}$`);
    const TRANSFORM_PATTERN = new RegExp(`^scale\\(${NUMBER}\\s+${NUMBER}\\)\\s+rotate\\(${NUMBER}\\)$`);
    const PATH_PATTERN = /^[MmLlHhVvCcSsQqTtAaZzEe0-9.,+\-\s]+$/;
    const POINTS_PATTERN = /^[0-9eE.,+\-\s]+$/;
    const FORBIDDEN_SCHEME_PATTERN = /^(?:https?|file|command|javascript|data):/i;

    const DOMPURIFY_CONFIG = Object.freeze({
        ALLOWED_TAGS,
        ALLOWED_ATTR: ALLOWED_ATTRIBUTES,
        ALLOW_ARIA_ATTR: false,
        ALLOW_DATA_ATTR: false,
        ALLOW_UNKNOWN_PROTOCOLS: false,
        FORBID_TAGS: ['a', 'style', 'script', 'foreignObject', 'defs', 'clipPath', 'tspan', 'image', 'use'],
        FORBID_ATTR: ['href', 'xlink:href', 'style'],
        RETURN_DOM_FRAGMENT: true,
        SANITIZE_DOM: true,
        SANITIZE_NAMED_PROPS: false,
    });

    function sanitizeSvg(svgText) {
        if (typeof svgText !== 'string') {
            throw new TypeError('SVG payload must be a string');
        }

        const fragment = DOMPurify.sanitize(svgText, DOMPURIFY_CONFIG);
        validatePurifierRemovals(DOMPurify.removed);
        const roots = Array.from(fragment.children);
        if (roots.length !== 1 || roots[0].localName !== 'svg') {
            throw new Error('Sanitized payload must contain exactly one SVG root');
        }

        const svg = roots[0];
        const markerIds = new Set();
        for (const element of [svg, ...svg.querySelectorAll('*')]) {
            const permittedAttributes = TAG_ATTRIBUTES[element.localName];
            if (!permittedAttributes) {
                throw new Error('Sanitized payload contains an unsupported SVG element');
            }

            if (element.hasAttribute('id')) {
                const id = element.getAttribute('id');
                if (element.localName !== 'g' || !MARKER_PATTERN.test(id)) {
                    element.removeAttribute('id');
                } else if (markerIds.has(id)) {
                    throw new Error('Sanitized payload contains a duplicate navigation marker');
                } else {
                    markerIds.add(id);
                }
            }

            for (const attribute of Array.from(element.attributes)) {
                if (!permittedAttributes.has(attribute.name)) {
                    throw new Error('Sanitized payload contains an attribute on an unsupported element');
                }
            }

            for (const attribute of Array.from(element.attributes)) {
                const value = attribute.value.trim();
                if (attribute.name !== 'xmlns' && (/url\s*\(/i.test(value) || FORBIDDEN_SCHEME_PATTERN.test(value))) {
                    throw new Error('Sanitized payload contains a forbidden resource value');
                }
            }

            validateOptionalValue(element, 'fill', COLOR_PATTERN);
            validateOptionalValue(element, 'stroke', COLOR_PATTERN);
            validateOptionalSetValue(element, 'font-family', FONT_FAMILIES);
            validateOptionalExactValue(element, 'xmlns', 'http://www.w3.org/2000/svg');
            validateOptionalExactValue(element, 'text-anchor', 'middle');
            validateOptionalValue(element, 'height', LENGTH_PATTERN);
            validateOptionalValue(element, 'width', LENGTH_PATTERN);
            validateOptionalValue(element, 'viewBox', VIEW_BOX_PATTERN);
            validateOptionalValue(element, 'transform', TRANSFORM_PATTERN);
            validateOptionalValue(element, 'd', PATH_PATTERN);
            validateOptionalValue(element, 'points', POINTS_PATTERN);
            for (const name of ['cx', 'cy', 'rx', 'ry', 'stroke-width', 'font-size', 'x', 'y']) {
                validateOptionalValue(element, name, NUMBER_PATTERN);
            }
        }

        return {fragment, svg, markerIds: Object.freeze(Array.from(markerIds))};
    }

    function validatePurifierRemovals(removals) {
        for (const removal of removals) {
            if (removal.element?.localName === 'style' || removal.element?.localName === 'body') {
                continue;
            }
            const attributeName = removal.attribute?.name;
            if (attributeName === 'class' || attributeName === 'xmlns:xlink') {
                continue;
            }
            const constructKind = removal.element ? 'element' : 'attribute';
            const constructName = boundedConstructName(removal.element?.localName ?? attributeName);
            throw new Error(`DOMPurify removed an unsupported SVG ${constructKind}: ${constructName}`);
        }
    }

    function boundedConstructName(value) {
        return typeof value === 'string' && /^[a-z0-9:_-]{1,40}$/i.test(value) ? value : 'unknown';
    }

    function validateOptionalValue(element, attributeName, pattern) {
        if (element.hasAttribute(attributeName) && !pattern.test(element.getAttribute(attributeName).trim())) {
            throw new Error('Sanitized payload contains an invalid SVG attribute value');
        }
    }

    function validateOptionalSetValue(element, attributeName, values) {
        if (element.hasAttribute(attributeName) && !values.has(element.getAttribute(attributeName))) {
            throw new Error('Sanitized payload contains an unsupported SVG attribute value');
        }
    }

    function validateOptionalExactValue(element, attributeName, expected) {
        if (element.hasAttribute(attributeName) && element.getAttribute(attributeName) !== expected) {
            throw new Error('Sanitized payload contains an unsupported SVG attribute value');
        }
    }

    globalThis.SanitizerContract = Object.freeze({MARKER_PATTERN, sanitizeSvg});
})();
