import { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { pathToFileURL } from 'node:url';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { I18nProvider } from '@/lib/i18n';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { SyntheticMessage } from '@/lib/opencode/model';
import { useGuestsStore } from '@/lib/guests/store';
import { SyncProvider, useChildStoreManager } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

plugin({
    name: 'timeline-notice-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
            loader: 'js',
        }));
    },
});

const { TimelineNotice } = await import('./TimelineNotice');

const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
    currentTheme: theme,
    availableThemes: [theme],
    setTheme: unexpectedThemeChange,
    customThemesLoading: false,
    reloadCustomThemes: unexpectedThemeChange,
    importTheme: unexpectedThemeChange,
    deleteImportedTheme: unexpectedThemeChange,
    customThemeIds: [],
    isSystemPreference: false,
    setSystemPreference: unexpectedThemeChange,
    themeMode: 'light',
    setThemeMode: unexpectedThemeChange,
    lightThemeId: theme.metadata.id,
    darkThemeId: getDefaultTheme(true).metadata.id,
    setLightThemePreference: unexpectedThemeChange,
    setDarkThemePreference: unexpectedThemeChange,
};

test('a subagent notice toggles its namespaced context group without closing the task', async () => {
    const happyWindow = new Window({ url: 'http://localhost' });
    const globals = {
        window: happyWindow,
        document: happyWindow.document,
        navigator: happyWindow.navigator,
        localStorage: happyWindow.localStorage,
        customElements: happyWindow.customElements,
        Node: happyWindow.Node,
        Text: happyWindow.Text,
        NodeList: happyWindow.NodeList,
        Element: happyWindow.Element,
        HTMLElement: happyWindow.HTMLElement,
        SVGElement: happyWindow.SVGElement,
        requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
        cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
        getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
        ResizeObserver: happyWindow.ResizeObserver,
        MutationObserver: happyWindow.MutationObserver,
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(globals).map(
        (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    );
    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => new Response('[]') });
    const previousDirectory = useDirectoryStore.getState().currentDirectory;
    let manager: ReturnType<typeof useChildStoreManager> | undefined;
    const CaptureManager = () => { manager = useChildStoreManager(); return null; };
    const message: SyntheticMessage = {
        id: 'notice', sessionID: 'parent', role: 'synthetic',
        time: { created: 3 }, text: '<subagent>done</subagent>', description: 'Inspect files',
        metadata: { source: 'subagent', childID: 'child', agent: 'explore', state: 'completed' },
    };

    try {
        useDirectoryStore.setState({ currentDirectory: '/workspace' });
        useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
        await act(async () => root.render(
            <SyncProvider sdk={sdk} directory="/workspace">
                <CaptureManager />
                <I18nProvider>
                    <ThemeSystemContext.Provider value={themeContext}>
                        <TimelineNotice message={message} />
                    </ThemeSystemContext.Provider>
                </I18nProvider>
            </SyncProvider>,
        ));
        if (!manager) throw new Error('Sync manager did not mount');
        await act(async () => manager!.ensureChild('/workspace', { bootstrap: false }).setState({
            message: { child: [{
                id: 'child-message', sessionID: 'child', role: 'assistant', agent: 'explore', providerID: 'test', modelID: 'test', time: { created: 1, completed: 2 },
            }] },
            part: { 'child-message': [
                { id: 'read', sessionID: 'child', messageID: 'child-message', type: 'tool', callID: 'read', tool: 'read', state: { status: 'completed', input: { filePath: '/workspace/a.ts' }, output: '', time: { start: 1, end: 2 } } },
                { id: 'grep', sessionID: 'child', messageID: 'child-message', type: 'tool', callID: 'grep', tool: 'grep', state: { status: 'completed', input: { pattern: 'needle' }, output: '', time: { start: 1, end: 2 } } },
            ] },
        }));
        const taskToggle = container.querySelector<HTMLElement>('[role="button"]');
        if (!taskToggle) throw new Error('Task toggle did not render');
        await act(async () => { taskToggle.click(); });
        expect(taskToggle.getAttribute('aria-expanded')).toBe('true');
        const groupToggle = container.querySelector<HTMLButtonElement>('[aria-label^="Expand context tool details"]');
        if (!groupToggle) throw new Error('Context group toggle did not render');
        expect(groupToggle.getAttribute('aria-expanded')).toBe('false');
        await act(async () => { groupToggle.click(); });
        expect(groupToggle.getAttribute('aria-expanded')).toBe('true');
        expect(taskToggle.getAttribute('aria-expanded')).toBe('true');
        expect(container.textContent).toContain('a.ts');
        expect(container.textContent).toContain('needle');
    } finally {
        await act(async () => root.unmount());
        useDirectoryStore.setState({ currentDirectory: previousDirectory });
        await happyWindow.happyDOM.abort();
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});
