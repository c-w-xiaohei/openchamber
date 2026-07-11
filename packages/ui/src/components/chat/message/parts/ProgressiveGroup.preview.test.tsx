import React from 'react';
import { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import type { TurnActivityRecord } from '../../lib/turns/types';

plugin({ name: 'progressive-group-worker-url', setup(build) { build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({ contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js' })); } });
const { default: ProgressiveGroup } = await import('./ProgressiveGroup');

const tool = (id: string, name: 'read' | 'skill'): TurnActivityRecord => ({ id, turnId: 'turn', messageId: 'message', partIndex: Number(id.replace(/\D/g, '')), kind: 'tool', endedAt: 2, part: { id, sessionID: 'session', messageID: 'message', type: 'tool', callID: id, tool: name, state: { status: 'completed', input: name === 'read' ? { filePath: `/workspace/${id}.ts` } : { id: 'test' }, output: '', time: { start: 1, end: 2 } } } });

test('collapsed preview counts hidden context actions rather than group rows', async () => {
    const window = new Window({ url: 'http://localhost' });
    const globals = {
        window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
        Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
        requestAnimationFrame: window.requestAnimationFrame.bind(window),
        cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
        getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(<I18nProvider><ProgressiveGroup parts={[...Array.from({ length: 10 }, (_, index) => tool(`read-${index}`, 'read')), tool('skill-1', 'skill')]} isExpanded={false} collapsedPreviewCount={1} onToggle={() => {}} isMobile={false} expandedTools={new Set()} onToggleTool={() => {}} onShowPopup={() => {}} streamPhase="completed" showHeader animateRows={false} /></I18nProvider>));
        expect(container.textContent).toContain('+10 more...');
    } finally {
        await act(async () => root.unmount());
        await window.happyDOM.abort();
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});
