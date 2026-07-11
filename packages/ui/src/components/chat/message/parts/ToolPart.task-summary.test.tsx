import { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider, useChildStoreManager } from '@/sync/sync-context';
import { getImperativeSessionMessageLoader } from '@/sync/session-message-loader';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useGuestsStore } from '@/lib/guests/store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'tool-guest-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { default: ToolPart } = await import('./ToolPart');

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

const parent: ToolPartData = {
  id: 'parent-call', sessionID: 'parent', messageID: 'parent-message',
  type: 'tool', tool: 'subagent', callID: 'parent-call',
  state: {
    status: 'completed', input: { description: 'Update files' },
    output: '', metadata: { sessionID: 'child' }, time: { start: 1, end: 2 },
  },
};

const patchPart = (paths: string[]): ToolPartData => ({
  id: 'patch-call', sessionID: 'child', messageID: 'child-message',
  type: 'tool', tool: 'patch', callID: 'patch-call',
  state: {
    status: 'completed',
    input: { patchText: ['*** Begin Patch', ...paths.flatMap((path) => [
      `*** Add File: ${path}`, '+content',
    ]), '*** End Patch'].join('\n') },
    output: '', metadata: {}, time: { start: 1, end: 2 },
  },
});

const contextPart = (id: string, tool: 'read' | 'grep'): ToolPartData => ({
  id, sessionID: 'child', messageID: 'child-message', type: 'tool', tool, callID: id,
  state: tool === 'read'
    ? { status: 'completed', input: { filePath: '/workspace/README.md' }, output: '', time: { start: 1, end: 2 } }
    : { status: 'completed', input: { pattern: 'needle' }, output: '', time: { start: 1, end: 2 } },
});

const childSession = (id: string) => ({
  id, parentID: 'parent', projectID: 'p', directory: '/workspace', title: id, agent: 'build',
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

const withHarness = async (
    toolPart: ToolPartData,
    run: (
      store: ReturnType<ReturnType<typeof useChildStoreManager>['ensureChild']>,
      container: HTMLElement,
      renderTool: (part: ToolPartData, isExpanded: boolean) => Promise<void>,
    ) => Promise<void>,
    initialExpanded = true,
    prepare?: (store: ReturnType<ReturnType<typeof useChildStoreManager>['ensureChild']>) => Promise<void>,
) => {
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
  const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
  });

  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  let manager: ReturnType<typeof useChildStoreManager> | undefined;
  const CaptureManager = () => { manager = useChildStoreManager(); return null; };
  const renderTool = async (part: ToolPartData, isExpanded: boolean) => {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="/workspace">
          <CaptureManager />
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={part} isExpanded={isExpanded} isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
  };
  try {
    useDirectoryStore.setState({ currentDirectory: '/workspace' });
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="/workspace">
          <CaptureManager />
        </SyncProvider>,
      );
    });
    if (!manager) throw new Error('Sync manager did not mount');
    const store = manager.ensureChild('/workspace', { bootstrap: false });
    await prepare?.(store);
    await renderTool(toolPart, initialExpanded);

    await run(store, container, renderTool);
  } finally {
    await act(async () => { root.unmount(); });
    useDirectoryStore.setState({ currentDirectory: previousDirectory });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('subagent patch summaries show file names and update when the same call changes', async () => {
  await withHarness(parent, async (store, container) => {
  const renderPatch = async (paths: string[]) => {
    await act(async () => store.setState({
      message: { child: [{
        id: 'child-message', sessionID: 'child', role: 'assistant',
        agent: 'build', providerID: 'test', modelID: 'test',
        time: { created: 1, completed: 2 },
      }] },
      part: { 'child-message': [patchPart(paths)] },
    }));
  };

  await renderPatch(['src/one.ts', 'src/two.ts']);
  expect(container.textContent).toContain('Apply Patch');
  expect(container.textContent).toContain('one.ts, two.ts');
  expect(container.textContent).not.toContain('src/one.ts');

  await renderPatch(['src/new.ts', 'src/second.ts', 'src/third.ts', 'src/fourth.ts', 'src/fifth.ts']);
  expect(container.textContent).toContain('new.ts, second.ts, third.ts +2');
  expect(container.textContent).not.toContain('one.ts, two.ts');
  expect(container.textContent).not.toContain('fourth.ts');

  await renderPatch(['C:\\repo\\windows.ts', 'C:\\repo\\other.ts']);
  expect(container.textContent).toContain('windows.ts, other.ts');
  expect(container.textContent).not.toContain('C:\\repo');

  await renderPatch(['src/single.ts']);
  expect(container.textContent).toContain('single.ts');
  });
});

test('a running subagent without the progress join resolves its child session from the store', async () => {
  const running: ToolPartData = {
    ...parent,
    state: { status: 'running', input: { description: 'Look around', agent: 'explore' }, time: { start: 100 } },
  };
  await withHarness(running, async (store, container) => {
    expect(container.textContent).toContain('Waiting for subagent activity');
    await act(async () => store.setState({
      session: [{
        id: 'child', parentID: 'parent', projectID: 'p', directory: '/workspace', title: 'child', agent: 'explore',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 120, updated: 120 },
      }],
      message: { child: [{
        id: 'child-message', sessionID: 'child', role: 'assistant',
        agent: 'explore', providerID: 'test', modelID: 'test',
        time: { created: 121, completed: 122 },
      }] },
      part: { 'child-message': [patchPart(['src/found.ts'])] },
    }));
    expect(container.textContent).not.toContain('Waiting for subagent activity');
    expect(container.textContent).toContain('found.ts');
  });
});

test('a collapsed finalized subagent with metadata fallback still renders authoritative child activity first', async () => {
  const finalizedWithFallback: ToolPartData = {
    ...parent,
    state: {
      status: 'completed', input: parent.state.input, output: '', time: { start: 1, end: 2 },
      metadata: {
        sessionID: 'child',
        summary: [{ id: 'fallback', tool: 'shell', state: { status: 'completed', title: 'fallback action' } }],
      },
    },
  };
  await withHarness(finalizedWithFallback, async (store, container, renderTool) => {
    await act(async () => store.setState({
      message: { child: [{
        id: 'child-message', sessionID: 'child', role: 'assistant',
        agent: 'build', providerID: 'test', modelID: 'test', time: { created: 1, completed: 2 },
      }] },
      part: { 'child-message': [contextPart('read-child', 'read'), contextPart('grep-child', 'grep')] },
    }));
    expect(container.textContent).toContain('Explored');
    expect(container.textContent).toContain('1 read');
    expect(container.textContent).toContain('1 search');
    expect(container.textContent).not.toContain('fallback action');
    await renderTool(finalizedWithFallback, false);
    expect(container.textContent).toContain('Explored');
    expect(container.textContent).not.toContain('fallback action');
  }, false, async (store) => {
    await act(async () => store.setState({ session: [childSession('child')] }));
  });
});

test('Agent Task materialization waits for expansion only when finalized metadata already summarizes an indexed child', async () => {
  const finalizedWithFallback: ToolPartData = {
    ...parent,
    state: {
      status: 'completed', input: parent.state.input, output: '', time: { start: 1, end: 2 },
      metadata: {
        sessionID: 'child',
        summary: [{ id: 'fallback', tool: 'shell', state: { status: 'completed', title: 'fallback action' } }],
      },
    },
  };
  let refreshes = 0;
  let restoreRefreshTail: (() => void) | undefined;
  await withHarness(finalizedWithFallback, async (_store, _container, renderTool) => {
    expect(refreshes).toBe(0);
    await renderTool(finalizedWithFallback, true);
    await act(async () => { await Promise.resolve(); });
    expect(refreshes).toBe(1);
  }, false, async (store) => {
    const loader = getImperativeSessionMessageLoader();
    if (!loader) throw new Error('SyncProvider did not register its public session loader');
    const refreshTail = loader.refreshTail;
    loader.refreshTail = async () => { refreshes += 1; };
    restoreRefreshTail = () => { loader.refreshTail = refreshTail; };
    await act(async () => store.setState({ session: [childSession('child')] }));
  }).finally(() => restoreRefreshTail?.());
});

test('Agent Task materializes indexed children without a valid finalized fallback, including running tasks', async () => {
  const cases: Array<{ sessionID: string; part: ToolPartData }> = [
    {
      sessionID: 'child-running',
      part: {
        ...parent,
        state: { status: 'running', input: parent.state.input, time: { start: 1 }, metadata: { sessionID: 'child-running' } },
      },
    },
    {
      sessionID: 'child-no-fallback',
      part: {
        ...parent,
        state: { status: 'completed', input: parent.state.input, output: '', time: { start: 1, end: 2 }, metadata: { sessionID: 'child-no-fallback' } },
      },
    },
  ];
  for (const fixture of cases) {
    let refreshes = 0;
    let restoreRefreshTail: (() => void) | undefined;
    await withHarness(fixture.part, async () => {
      await act(async () => { await Promise.resolve(); });
      expect(refreshes).toBe(1);
    }, false, async (store) => {
      const loader = getImperativeSessionMessageLoader();
      if (!loader) throw new Error('SyncProvider did not register its public session loader');
      const refreshTail = loader.refreshTail;
      loader.refreshTail = async () => { refreshes += 1; };
      restoreRefreshTail = () => { loader.refreshTail = refreshTail; };
      await act(async () => store.setState({ session: [childSession(fixture.sessionID)] }));
    }).finally(() => restoreRefreshTail?.());
  }
});
