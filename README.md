# leradeveloper

Navegue, instale e acompanhe agentes de IA no Claude Code, Codex, Cursor, Gemini CLI, Copilot, Qwen, opencode, Osaurus, Antigravity, ZCode e DeepSeek Harness, direto no navegador.

O leradeveloper é um fork do [Agency Agents](https://agencyagents.app) de Michael Sitarzewski (MIT). Ele mantém a mesma interface e o mesmo catálogo ([agency-agents](https://github.com/msitarzewski/agency-agents)), mas troca o app nativo (Tauri/Rust) por um servidor Node local que abre no seu navegador. Assim ele roda igual em Windows, macOS e Linux, sem instalador assinado.

## Instalação

**Windows** (via [Scoop](https://scoop.sh)):

```powershell
scoop bucket add leradeveloper https://github.com/paulopng/homebrew-leradeveloper
scoop install leradeveloper
```

**macOS / Linux / WSL** (via [Homebrew](https://brew.sh)):

```bash
brew install paulopng/leradeveloper/leradeveloper
```

Depois é só rodar `leradeveloper`. O app abre em `http://127.0.0.1:4747`. No Windows, ele também aparece no menu Iniciar.

Para atualizar, use `scoop update leradeveloper` ou `brew upgrade leradeveloper`.

| Opção | O que faz |
|---|---|
| `--port N` | Usa outra porta (padrão: 4747, ou a próxima livre) |
| `--no-open` | Não abre o navegador automaticamente |
| `--version` | Mostra a versão |

## O que ele faz

- **Catálogo:** mais de 280 agentes organizados por divisão, com o persona completo antes de instalar.
- **Instalação por ferramenta:** escreve cada agente no formato da ferramenta, byte a byte igual ao `convert.sh` oficial.
- **Registro de instalações:** guarda o que foi escrito, onde e com qual hash. Detecta arquivos desatualizados, editados ou removidos.
- **Backups:** toda escrita que sobrescreve algo guarda a versão anterior antes.
- **Projetos e times:** instalação por projeto, times prontos e Agentfiles para levar sua configuração para outra máquina.
- **Catálogo próprio:** use o snapshot embutido, um clone gerenciado em `~/.agency-agents` ou o seu próprio fork do catálogo.

Os dados do app ficam em:
- Windows: `%APPDATA%\leradeveloper`
- macOS: `~/Library/Application Support/leradeveloper`
- Linux: `~/.local/share/leradeveloper`

## Decisor Jev

O leradeveloper traz o `lera-decisor`, um servidor MCP que dá aos seus agentes um decisor baseado no **Jev** (TypeSafe), acessado pelo defapi. Os agentes chamam o decisor antes de rotear, aprovar ou escolher caminhos:

- **`decidir`**: pergunta de sim/não. Acima de 70% ou abaixo de 30% a decisão é confiante; entre 30% e 70% o agente **para e pergunta a você**.
- **`escolher`**: ranking entre 2 e 20 opções.
- **`historico_decisoes`**: as últimas decisões tomadas nesta máquina.

Para configurar:

1. Salve a chave do defapi na variável de usuário `TYPESAFE_API_KEY` (no Windows, em "Editar as variáveis de ambiente para sua conta").
2. Teste a chave: `lera-decisor --testar`
3. Ligue o decisor ao Claude Code, ao Codex e ao Cursor de uma vez: `lera-decisor --instalar`. Cada arquivo de configuração alterado ganha uma cópia `.bak-lera` antes.
4. Reinicie as ferramentas. No Claude Code, `/mcp` deve mostrar `jev` conectado.

Os limites da zona de dúvida podem ser ajustados com `JEV_LIMIAR_BAIXO` e `JEV_LIMIAR_ALTO`. O Jev não faz contas nem compara datas: os agentes calculam esses fatos antes e mandam o resultado no contexto.

## Desenvolvimento

```bash
npm install
npm run dev     # servidor --dev (porta 4748) + Vite com hot reload (porta 1430)
npm test        # testes do servidor
npm run build   # gera build/ (interface estática)
npm start       # roda o app como o usuário final
```

A estrutura está em [CLAUDE.md](CLAUDE.md). Para conferir paridade com o conversor oficial, veja `test/parity.mjs`.

## Publicando uma versão

1. Atualize `version` no `package.json` e envie para a `main`.
2. O workflow **Release** cria a tag `vX.Y.Z`, compila, roda os testes e publica os arquivos `.tar.gz` e `.zip` na página de releases.
3. Se o segredo `TAP_TOKEN` existir, ele também atualiza sozinho a fórmula do Homebrew e o manifesto do Scoop em `paulopng/homebrew-leradeveloper`. Sem o segredo, os dois arquivos ficam anexados à release para você copiar.

## Licença

MIT. Mantém o aviso de copyright original de Michael Sitarzewski; veja [LICENSE](LICENSE).
