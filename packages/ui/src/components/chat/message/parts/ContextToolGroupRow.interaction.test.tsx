import React from 'react';
import { act } from 'react';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { EditorAPI, RuntimeAPIs } from '@/lib/api/types';
import { DedicatedMobileAppProvider } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { I18nProvider } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { projectToolSegmentRows } from './toolSegmentProjection';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { ContextToolGroupRow } from './ContextToolGroupRow';

const unavailable = (): never => { throw new Error('Unexpected runtime API'); };
const makeRuntime = (openFile?: EditorAPI['openFile']): RuntimeAPIs => ({
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); },
    get git() { return unavailable(); },
    get files() { return unavailable(); },
    get settings() { return unavailable(); },
    get permissions() { return unavailable(); },
    get notifications() { return unavailable(); },
    editor: openFile ? { openFile, openDiff: async () => {} } : undefined,
});

const activity = (id: string, tool: 'read' | 'grep' | 'list', input: ToolPart['state']['input']): TurnActivityRecord => ({
    id,
    turnId: 'turn',
    messageId: 'message',
    partIndex: id === 'read' ? 0 : 1,
    kind: 'tool',
    endedAt: 2,
    part: {
        id,
        sessionID: 'session',
        messageID: 'message',
        type: 'tool',
        callID: id,
        tool,
        state: { status: 'completed', input, output: '', time: { start: 1, end: 2 } },
    },
});

const installDOM = () => {
    const window = new Window({ url: 'http://localhost' });
    const globals = { window, document: window.document, navigator: window.navigator, localStorage: window.localStorage, customElements: window.customElements, Node: window.Node, Text: window.Text, NodeList: window.NodeList, Element: window.Element, HTMLElement: window.HTMLElement, SVGElement: window.SVGElement, requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    return { window, restore: async () => { await window.happyDOM.abort(); for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } } };
};

test('grouped Read opens its projected full target without closing the controlled group', async () => {
    const dom = installDOM();
    const previousDirectory = useDirectoryStore.getState().currentDirectory;
    const calls: Array<[string, number | undefined]> = [];
    const first = projectToolSegmentRows([activity('read', 'read', { filePath: '/workspace/a/index.ts', offset: 4 }), activity('grep', 'grep', { pattern: 'needle' })])[0];
    const second = projectToolSegmentRows([activity('read', 'read', { filePath: '/workspace/b/index.ts', line: 9 }), activity('grep', 'grep', { pattern: 'needle' })])[0];
    if (first?.type !== 'context-tool-group' || second?.type !== 'context-tool-group') throw new Error('Expected context groups');
    const container = document.createElement('div');
    const root = createRoot(container);
    const Owner = ({ row }: { row: typeof first }) => {
        const [expanded, setExpanded] = React.useState(false);
        return <ContextToolGroupRow {...row} rowKey={row.key} animateTailText={false} isExpanded={expanded} onToggleTool={() => setExpanded((value) => !value)} />;
    };
    try {
        useDirectoryStore.setState({ currentDirectory: '/workspace' });
        await act(async () => root.render(<RuntimeAPIContext.Provider value={makeRuntime(async (path, line) => { calls.push([path, line]); })}><I18nProvider><Owner row={first} /></I18nProvider></RuntimeAPIContext.Provider>));
        const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Expand context tool details"]');
        if (!trigger) throw new Error('Missing group trigger');
        await act(async () => { trigger.click(); });
        const read = container.querySelector<HTMLButtonElement>('button[title="/workspace/a/index.ts:4"]');
        if (!read) throw new Error('Missing readable file target');
        await act(async () => { read.click(); });
        expect(calls).toEqual([['/workspace/a/index.ts', 4]]);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        await act(async () => root.render(<RuntimeAPIContext.Provider value={makeRuntime(async (path, line) => { calls.push([path, line]); })}><I18nProvider><Owner row={second} /></I18nProvider></RuntimeAPIContext.Provider>));
        const updated = container.querySelector<HTMLButtonElement>('button[title="/workspace/b/index.ts:9"]');
        if (!updated) throw new Error('Missing updated readable file target');
        await act(async () => { updated.click(); });
        expect(calls).toEqual([['/workspace/a/index.ts', 4], ['/workspace/b/index.ts', 9]]);
    } finally {
        await act(async () => root.unmount());
        useDirectoryStore.setState({ currentDirectory: previousDirectory });
        await dom.restore();
    }
});

test('only trusted grouped Read children are buttons', async () => {
    const dom = installDOM();
    const row = projectToolSegmentRows([activity('read', 'read', {}), activity('grep', 'grep', { pattern: 'needle' }), activity('list', 'list', { path: '/workspace' })])[0];
    if (row?.type !== 'context-tool-group') throw new Error('Expected context group');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(<I18nProvider><ContextToolGroupRow {...row} rowKey={row.key} animateTailText={false} isExpanded onToggleTool={() => {}} /></I18nProvider>));
        expect(container.querySelectorAll('button:not([aria-expanded])')).toHaveLength(0);
    } finally {
        await act(async () => root.unmount());
        await dom.restore();
    }
});

test('grouped Read uses pending-file navigation and dedicated mobile Files when no editor exists', async () => {
    const dom = installDOM();
    const previousDirectory = useDirectoryStore.getState().currentDirectory;
    const previousNavigation = useUIStore.getState().pendingFileNavigation;
    const opened: string[] = [];
    const row = projectToolSegmentRows([activity('read', 'read', { filePath: '/outside/ReadMe.TS', line: 3 }), activity('grep', 'grep', { pattern: 'needle' })])[0];
    if (row?.type !== 'context-tool-group') throw new Error('Expected context group');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        useDirectoryStore.setState({ currentDirectory: '/workspace' });
        await act(async () => root.render(<RuntimeAPIContext.Provider value={makeRuntime()}><DedicatedMobileAppProvider actions={{ openFiles: () => opened.push('files'), openChanges: () => {}, openSettings: () => {} }}><I18nProvider><ContextToolGroupRow {...row} rowKey={row.key} animateTailText={false} isExpanded onToggleTool={() => {}} /></I18nProvider></DedicatedMobileAppProvider></RuntimeAPIContext.Provider>));
        const read = container.querySelector<HTMLButtonElement>('button[title="/outside/ReadMe.TS:3"]');
        if (!read) throw new Error('Missing readable file target');
        await act(async () => { read.click(); });
        expect(opened).toEqual(['files']);
        expect(useUIStore.getState().pendingFileNavigation).toMatchObject({ path: '/outside/ReadMe.TS', line: 3, column: 1 });
    } finally {
        await act(async () => root.unmount());
        useDirectoryStore.setState({ currentDirectory: previousDirectory });
        useUIStore.setState({ pendingFileNavigation: previousNavigation });
        await dom.restore();
    }
});
