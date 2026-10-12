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
