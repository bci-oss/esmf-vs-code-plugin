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

import type * as vscode from 'vscode';

export const GRAPHICAL_VIEW_RENDER_REQUEST = 'turtle/graphicalView/render';
export const GRAPHICAL_VIEW_RESOLVE_TARGET_REQUEST = 'turtle/graphicalView/resolveTarget';
export const GRAPHICAL_VIEW_RESOLVE_ATTRIBUTE_TARGET_REQUEST = 'turtle/graphicalView/resolveAttributeTarget';
export const GRAPHICAL_VIEW_HEADER_MARKER_PATTERN = /^gv-header-[a-z0-9]{16,32}$/;
export const GRAPHICAL_VIEW_ATTRIBUTE_MARKER_PATTERN = /^gv-attribute-[a-z0-9]{16,32}$/;
export const GRAPHICAL_VIEW_MARKER_PATTERN = /^gv-(?:header|attribute)-[a-z0-9]{16,32}$/;

export type GraphicalViewRenderWarning =
    | 'unsupportedUri'
    | 'missingDocument'
    | 'modelTooLarge'
    | 'timeout'
    | 'temporarilyUnresolvable';

export type GraphicalViewResolveTargetWarning = 'notFound' | 'ambiguous' | 'unsupportedUri' | 'temporarilyUnresolvable';

export interface GraphicalViewRenderParams {
    uri: string;
    includeAttributeRows?: boolean;
}

export interface GraphicalViewElementHeaderTarget {
    id: string;
    kind: 'elementHeader';
    elementUrn: string;
}

export interface GraphicalViewAttributeTarget {
    id: string;
    kind: 'attributeRow';
    ownerUrn: string;
    predicateUrn: string;
    selection: 'singleOccurrence' | 'predicateStart';
    language?: string;
}

export type GraphicalViewTarget = GraphicalViewElementHeaderTarget | GraphicalViewAttributeTarget;

export interface GraphicalViewRenderResult {
    uri: string;
    svg?: string | null;
    targets: GraphicalViewTarget[];
    warnings: GraphicalViewRenderWarning[];
}

export interface GraphicalViewResolveTargetParams {
    sourceUri: string;
    elementUrn: string;
}

export interface GraphicalViewPosition {
    line: number;
    character: number;
}

export interface GraphicalViewLocation {
    uri: string;
    range: {
        start: GraphicalViewPosition;
        end: GraphicalViewPosition;
    };
}

export interface GraphicalViewResolveTargetResult {
    location?: GraphicalViewLocation | null;
    warning?: GraphicalViewResolveTargetWarning | null;
}

export interface GraphicalViewResolveAttributeTargetParams {
    sourceUri: string;
    ownerUrn: string;
    predicateUrn: string;
    selection: 'singleOccurrence' | 'predicateStart';
    language?: string;
}

export type GraphicalViewResolveAttributeTargetResult = GraphicalViewResolveTargetResult;

export interface GraphicalViewRequestClient {
    isGraphicalViewAvailable(): boolean;
    onDidChangeGraphicalViewAvailability(listener: (available: boolean) => void): vscode.Disposable;
    renderGraphicalView(params: GraphicalViewRenderParams, token: vscode.CancellationToken): Thenable<GraphicalViewRenderResult>;
    resolveGraphicalViewTarget(
        params: GraphicalViewResolveTargetParams,
        token?: vscode.CancellationToken,
    ): Thenable<GraphicalViewResolveTargetResult>;
    resolveGraphicalViewAttributeTarget(
        params: GraphicalViewResolveAttributeTargetParams,
        token?: vscode.CancellationToken,
    ): Thenable<GraphicalViewResolveAttributeTargetResult>;
}

const RENDER_WARNINGS: ReadonlySet<string> = new Set([
    'unsupportedUri',
    'missingDocument',
    'modelTooLarge',
    'timeout',
    'temporarilyUnresolvable',
]);
const ASPECT_MODEL_URN_PATTERN = /^urn:samm:[^\s#]+#[^\s#]+$/;
const LANGUAGE_PATTERN = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/;
const SVG_ID_PATTERN = /\bid\s*=\s*(["'])([^"']+)\1/g;
const GRAPHPER_DESCENDANT_PATTERN = /^gv-(?:header|attribute)-[a-z0-9]{16,32}_(?:polygon|text_0)$/;

export function isGraphicalViewRenderResult(value: unknown): value is GraphicalViewRenderResult {
    if (!isRecord(value) || typeof value.uri !== 'string' || !Array.isArray(value.targets) || !Array.isArray(value.warnings)) {
        return false;
    }

    const allowedResultKeys = value.svg === undefined ? ['targets', 'uri', 'warnings'] : ['svg', 'targets', 'uri', 'warnings'];
    if (!hasExactKeys(value, allowedResultKeys)) {
        return false;
    }

    if (value.svg !== undefined && value.svg !== null && typeof value.svg !== 'string') {
        return false;
    }

    if (!value.warnings.every(warning => typeof warning === 'string' && RENDER_WARNINGS.has(warning))) {
        return false;
    }

    if (!value.targets.every(isGraphicalViewTarget)) {
        return false;
    }

    if (value.svg === undefined || value.svg === null) {
        return value.targets.length === 0 && value.warnings.length > 0;
    }

    return value.svg.trim().length > 0 && hasConsistentSidecar(value.svg, value.targets);
}

function isGraphicalViewTarget(value: unknown): value is GraphicalViewTarget {
    if (!isRecord(value) || typeof value.id !== 'string') {
        return false;
    }
    if (value.kind === 'elementHeader') {
        return hasExactKeys(value, ['elementUrn', 'id', 'kind'])
            && GRAPHICAL_VIEW_HEADER_MARKER_PATTERN.test(value.id)
            && typeof value.elementUrn === 'string'
            && ASPECT_MODEL_URN_PATTERN.test(value.elementUrn);
    }
    if (value.kind !== 'attributeRow') {
        return false;
    }
    const expectedKeys = value.language === undefined
        ? ['id', 'kind', 'ownerUrn', 'predicateUrn', 'selection']
        : ['id', 'kind', 'language', 'ownerUrn', 'predicateUrn', 'selection'];
    return hasExactKeys(value, expectedKeys)
        && GRAPHICAL_VIEW_ATTRIBUTE_MARKER_PATTERN.test(value.id)
        && typeof value.ownerUrn === 'string'
        && ASPECT_MODEL_URN_PATTERN.test(value.ownerUrn)
        && typeof value.predicateUrn === 'string'
        && ASPECT_MODEL_URN_PATTERN.test(value.predicateUrn)
        && (value.selection === 'singleOccurrence' || value.selection === 'predicateStart')
        && (value.language === undefined
            || (value.selection === 'singleOccurrence'
                && typeof value.language === 'string'
                && LANGUAGE_PATTERN.test(value.language)));
}

function hasConsistentSidecar(svg: string, targets: GraphicalViewTarget[]): boolean {
    const targetIds = new Set<string>();
    for (const target of targets) {
        if (targetIds.has(target.id)) {
            return false;
        }
        targetIds.add(target.id);
    }

    const svgIds = new Set<string>();
    for (const match of svg.matchAll(SVG_ID_PATTERN)) {
        const id = match[2];
        if (GRAPHPER_DESCENDANT_PATTERN.test(id)) {
            continue;
        }
        if (!id.startsWith('gv-header-') && !id.startsWith('gv-attribute-')) {
            continue;
        }
        if (!GRAPHICAL_VIEW_MARKER_PATTERN.test(id)) {
            return false;
        }
        if (svgIds.has(id)) {
            return false;
        }
        svgIds.add(id);
    }

    return targetIds.size === svgIds.size && [...targetIds].every(id => svgIds.has(id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
    const actualKeys = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    return actualKeys.length === expected.length && actualKeys.every((key, index) => key === expected[index]);
}
