// Fase 3 do sync pós-#44047: ensaio ao vivo do fork refeito, sem tocar no Chrome do Gabriel.
//
// O que roda: um Chromium de teste (revisão do worktree, headless, perfil temporário, extensão do `dist` carregada) e
// dois servidores MCP pelo wrapper `scripts/run-mcp-server.cjs --extension --browser chromium`, cada um um processo,
// ambos com o mesmo clientName ("claude-code"), como duas abas do Claude Code. O `tests/extension/chrome-stub.js` faz
// o papel do chrome.exe (abre a página de conexão no Chromium de teste). Nenhum MCP do Claude Code é usado.
//
// Uso (da raiz do worktree, com build e `scripts/.build-stamp` em dia):
//   env -u PLAYWRIGHT_MCP_EXTENSION_TOKEN -u PLAYWRIGHT_MCP_EXTENSION -u PLAYWRIGHT_MCP_PROFILE_DIR_NAME \
//     node roadmap/2026-11-12-sync-upstream-pos-44047.d/ensaio.cjs <pasta de rascunho>
// Sai com 0 se todos os itens passarem; imprime um JSON com cada item.

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { chromium } = require(path.join(ROOT, 'packages', 'playwright-core'));
const { Client } = require(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'index.js'));
const { StdioClientTransport } = require(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'stdio.js'));

const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
const scratch = path.resolve(process.argv[2] || path.join(ROOT, 'temp', 'ensaio'));
const results = [];

function check(name, ok, detail) {
  results.push({ item: name, ok: !!ok, detail });
  process.stderr.write(`${ok ? 'VERDE' : 'VERMELHO'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}\n`);
}

async function poll(fn, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await fn();
    if (predicate(value))
      return value;
    await new Promise(f => setTimeout(f, 250));
  }
  return value;
}

function startPages() {
  const server = http.createServer((req, res) => {
    const title = decodeURIComponent(req.url.slice(1).split('?')[0]) || 'root';
    const body = title === 'Cookies'
      ? `<script>document.cookie = 'keep=1; max-age=3600'; document.cookie = 'drop=2; max-age=3600';</script>Page Cookies`
      : `Page ${title}`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${title}</title><body>${body}</body>`);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  fs.rmSync(scratch, { recursive: true, force: true });
  const userDataDir = path.join(scratch, 'udd');
  const extensionDir = path.join(scratch, 'extension');
  fs.mkdirSync(path.join(userDataDir, 'Default', 'Extensions', EXTENSION_ID), { recursive: true });
  fs.cpSync(path.join(ROOT, 'packages', 'extension', 'dist'), extensionDir, { recursive: true });
  const pages = await startPages();
  const urlOf = title => `http://127.0.0.1:${pages.address().port}/${encodeURIComponent(title)}`;

  const context = await chromium.launchPersistentContext(userDataDir, {
    // O canal `chromium` é o único que carrega extensão (o headless shell padrão não carrega).
    channel: 'chromium',
    headless: true,
    args: ['--remote-debugging-port=0', `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const clients = [];
  try {
    if (!context.serviceWorkers().length)
      await context.waitForEvent('serviceworker');
    const sw = () => context.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`));
    const chromeEval = (fn, arg) => sw().evaluate(fn, arg);
    const manifest = await chromeEval(() => chrome.runtime.getManifest().version);
    check('extensão carregada do dist', !!manifest, { versao: manifest, chromium: context.browser()?.version() ?? 'persistente' });

    const managePage = await context.newPage();
    await managePage.goto(`chrome-extension://${EXTENSION_ID}/manage.html`);
    const token = (await managePage.locator('.auth-token-code').textContent()).split('=')[1];
    await managePage.close();

    const groups = () => chromeEval(async () => {
      const [all, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
      return all.map(g => ({ title: g.title, color: g.color, tabs: tabs.filter(t => t.groupId === g.id).map(t => t.title).sort() })).sort((a, b) => a.title.localeCompare(b.title));
    });
    const activeTabs = () => chromeEval(async () => (await chrome.tabs.query({ active: true })).map(t => t.title));
    const tabTitles = () => chromeEval(async () => (await chrome.tabs.query({})).map(t => t.title));
    const stubLaunches = () => (fs.existsSync(path.join(userDataDir, 'chrome-stub.log')) ? fs.readFileSync(path.join(userDataDir, 'chrome-stub.log'), 'utf8').split('\n').filter(Boolean).length : 0);

    const baseEnv = { ...process.env };
    for (const key of Object.keys(baseEnv)) {
      if (key.startsWith('PLAYWRIGHT_MCP_') || key === 'CENTRAL_ORIGEM' || key === 'DEBUG')
        delete baseEnv[key];
    }
    async function startClient(label, extraArgs = []) {
      const stderr = [];
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'run-mcp-server.cjs'), '--extension', '--browser', 'chromium', ...extraArgs],
        cwd: scratch,
        stderr: 'pipe',
        env: {
          ...baseEnv,
          PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
          PWTEST_EXTENSION_USER_DATA_DIR: userDataDir,
          PLAYWRIGHT_MCP_EXECUTABLE_PATH: path.join(ROOT, 'tests', 'extension', 'chrome-stub.js'),
          PWTEST_CHROME_STUB_EXECUTABLE: chromium.executablePath(),
          PWTEST_CHROME_STUB_EXTENSION: extensionDir,
          // Chrome 157 (o do Gabriel) ignora --open-in-background: a página de conexão abre na frente.
          PWTEST_CHROME_STUB_FOREGROUND: '1',
          PLAYWRIGHT_MCP_AGENT_RELEASE_DIR: path.join(scratch, 'agentes-fim'),
          DEBUG: 'pw:mcp:relay,pw:mcp:shot,pw:mcp:router',
        },
      });
      transport.stderr.on('data', data => stderr.push(data.toString()));
      const client = new Client({ name: 'claude-code', version: '1.0.0' });
      await client.connect(transport);
      const entry = { label, client, stderr: () => stderr.join(''), pid: transport.pid };
      clients.push(entry);
      return entry;
    }
    const call = async (entry, name, args = {}, meta) => {
      const response = await entry.client.callTool({ name, arguments: meta ? { ...args, _meta: meta } : args }, undefined, { timeout: 180_000 });
      return { text: response.content?.map(c => c.text ?? '').join('\n') ?? '', isError: !!response.isError };
    };

    // O usuário está numa aba dele.
    const front = await context.newPage();
    await front.goto(urlOf('Front'));
    await front.bringToFront();

    // 1. Duas conexões com o mesmo clientName, cada uma rotula o grupo.
    const a = await startClient('A');
    const b = await startClient('B', ['--caps=storage']);
    const labelA = await call(a, 'browser_set_group_label', { label: 'ensaio-A' });
    await call(a, 'browser_navigate', { url: urlOf('A-main') });
    const labelB = await call(b, 'browser_set_group_label', { label: 'ensaio-B' });
    await call(b, 'browser_navigate', { url: urlOf('B-main') });
    const g1 = await poll(groups, g => g.length === 2);
    check('1. duas conexões com o mesmo clientName rotulam cada uma o seu grupo',
        !labelA.isError && !labelB.isError && JSON.stringify(g1.map(g => g.title)) === JSON.stringify(['Playwright · ensaio-A', 'Playwright · ensaio-B']), g1);
    check('1b. a aba do usuário continua na frente depois das duas conexões (Chrome 157 simulado)', JSON.stringify(await activeTabs()) === JSON.stringify(['Front']), await activeTabs());

    // 2. Subagente abre aba em segundo plano sem roubar foco, pelo portador.
    const launchesBefore = stubLaunches();
    const sub = { agente: 'agent-0000abcd', agenteTipo: 'general-purpose', sessao: 'ensaio' };
    const subNav = await call(a, 'browser_navigate', { url: urlOf('A-sub') }, sub);
    const g2 = await poll(groups, g => g.some(x => x.title.includes('gp-abcd')));
    check('2. subagente abre aba em segundo plano, no próprio grupo, sem roubar foco nem abrir o navegador de novo',
        !subNav.isError && g2.some(x => x.title === 'Playwright · ensaio-A · gp-abcd' && x.tabs.includes('A-sub')) && JSON.stringify(await activeTabs()) === JSON.stringify(['Front']) && stubLaunches() === launchesBefore,
        { grupos: g2, ativa: await activeTabs(), lancamentos: [launchesBefore, stubLaunches()], portador: /Connect page opened via portador/.test(a.stderr()) });

    // 3. Print de aba escondida < 60 s (janela sem foco: revela; com foco: não revela).
    await chromeEval(async () => {
      const [w] = await chrome.windows.getAll();
      await chrome.windows.update(w.id, { focused: false });
    });
    let t0 = Date.now();
    const shot1 = await call(a, 'browser_take_screenshot', {}, sub);
    const ms1 = Date.now() - t0;
    check('3a. print de aba escondida do subagente, janela sem foco (revela)', !shot1.isError && ms1 < 60_000 && /Capture of tab \d+: revealed=true/.test(a.stderr()) && JSON.stringify(await activeTabs()) === JSON.stringify(['Front']),
        { ms: ms1, revelou: /revealed=true/.test(a.stderr()), ativa: await activeTabs() });
    await chromeEval(async () => {
      const [w] = await chrome.windows.getAll();
      await chrome.windows.update(w.id, { focused: true });
    });
    t0 = Date.now();
    const shot2 = await call(a, 'browser_take_screenshot', {}, sub);
    const ms2 = Date.now() - t0;
    check('3b. print de aba escondida do subagente, janela com foco (não revela)', !shot2.isError && ms2 < 60_000 && JSON.stringify(await activeTabs()) === JSON.stringify(['Front']), { ms: ms2, shot: (a.stderr().match(/pw:mcp:shot .*/g) || []).slice(-2) });

    // 4. Desconectar fecha as abas do agente e solta as do usuário.
    const userTab = await context.newPage();
    await userTab.goto(urlOf('User-in-A'));
    await chromeEval(async () => {
      const tabs = await chrome.tabs.query({});
      const user = tabs.find(t => t.title === 'User-in-A');
      const agent = tabs.find(t => t.title === 'A-main');
      await chrome.tabs.group({ groupId: agent.groupId, tabIds: [user.id] });
    });
    await poll(groups, g => g.some(x => x.title === 'Playwright · ensaio-A' && x.tabs.includes('User-in-A')));
    await a.client.close();
    const g4 = await poll(groups, g => !g.some(x => x.title.includes('gp-abcd')) && g.some(x => x.color === 'grey'), 20000);
    const titles4 = await tabTitles();
    check('4. desconectar fecha as abas do agente (principal e subagente) e solta a do usuário (grupo cinza)',
        !titles4.includes('A-main') && !titles4.includes('A-sub') && titles4.includes('User-in-A') && g4.some(x => x.color === 'grey' && JSON.stringify(x.tabs) === JSON.stringify(['User-in-A'])) && titles4.includes('B-main'),
        { grupos: g4, abas: titles4 });

    // 5. Cookies: apagar um funciona, limpar tudo é recusado.
    await call(b, 'browser_navigate', { url: urlOf('Cookies') });
    const del = await call(b, 'browser_cookie_delete', { name: 'drop' });
    const list = await call(b, 'browser_cookie_list');
    const clear = await call(b, 'browser_cookie_clear');
    const list2 = await call(b, 'browser_cookie_list');
    check('5. browser_cookie_delete por nome funciona e browser_cookie_clear sem filtro é recusado',
        !del.isError && !list.text.includes('drop') && list.text.includes('keep') && clear.isError && /Storage.clearCookies is not allowed/.test(clear.text) && list2.text.includes('keep'),
        { apagar: del.text.slice(0, 120), limpar: clear.text.slice(0, 160) });

    await b.client.close();
  } finally {
    for (const entry of clients)
      await entry.client.close().catch(() => {});
    await context.close().catch(() => {});
    pages.close();
  }
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.exitCode = results.every(r => r.ok) ? 0 : 1;
}

main().catch(error => {
  process.stderr.write(`ensaio quebrou: ${error.stack}\n`);
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.exitCode = 2;
});
