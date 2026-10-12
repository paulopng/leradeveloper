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
| `--senha` | Define a senha e liga o acesso pelo celular |
| `--remoto-desligar` | Desliga o acesso pelo celular |
| `--remoto-status` | Mostra se o acesso remoto está ligado |
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

## Mapas 3D dos projetos

Em `http://127.0.0.1:4747/mapas` (ou pelo item **Mapas 3D** na barra lateral) fica o visualizador dos seus projetos em 3D. Cada camada é uma placa empilhada: dar zoom mergulha para a camada de baixo, e tocar num item mostra as ligações dele com as outras camadas, nos dois sentidos. Funciona com toque no celular.

Os mapas são arquivos JSON em `~/lera-projetos/mapas/` (a pasta do repositório de projetos). O agente **Gerador de grafos** escreve esses arquivos, mas dá para editar à mão. A tela atualiza sozinha quando o arquivo muda. Enquanto não houver nenhum mapa seu, aparecem dois exemplos.

Formato resumido:

```json
{
  "titulo": "Meu projeto",
  "atualizado": "2026-10-12",
  "camadas": [{ "id": "negocio", "rotulo": "Negócio" }, { "id": "sistemas", "rotulo": "Sistemas" }],
  "nos": [
    { "id": "meta", "camada": "negocio", "rotulo": "Meta do trimestre", "tipo": "marco", "status": "ok", "peso": 3 },
    { "id": "api", "camada": "sistemas", "rotulo": "API nova", "tipo": "sistema", "status": "atencao" }
  ],
  "ligacoes": [{ "de": "meta", "para": "api", "relacao": "depende de" }]
}
```

Tipos: `fonte`, `sistema`, `pessoas`, `entregavel`, `justificativa`, `risco`, `dado`, `humano`, `agente`, `ferramenta`, `decisao`, `tarefa`, `marco`, `ideia`. Status: `ok`, `atencao`, `bloqueado`, `confirmar`. Um nó pode trazer `"jev": { "pergunta", "probabilidade" }` com a última decisão do Jev sobre ele.

## Escritório dos agentes

Em `http://127.0.0.1:4747/escritorio` (ou pelo item **Escritório** na barra lateral) você acompanha os agentes como num jogo antigo, em pixel art. Cada agente ganha uma mesa com PC, com o nome e uma barra de progresso da tarefa em cima. A tela do PC e um balão mostram o que ele está fazendo: trabalhando, esperando você, bloqueado, com erro ou parado há mais de 30 minutos. Quando termina, ele comemora.

Na sala ao lado fica o **Jev**. Cada validação aparece como um envelope que sai da mesa do agente, passa pela máquina do Jev e volta com o resultado (`SIM 82%`, `NÃO 12%`). Quando o Jev fica na zona de dúvida, o envelope vai para a sua mesa e o sino toca.

O painel tem três abas:

- **Agentes:** tarefa, progresso, última mensagem e histórico de cada um.
- **Jev:** decisões do dia (sim, não, dúvida e custo) e cada validação com a probabilidade e a zona de dúvida marcada.
- **Config:** modelo do Jev, os dois limites da zona de dúvida e o crédito no defapi. A chave nunca aparece na tela.

Os agentes atualizam a mesa com a ferramenta `registrar_atividade` do decisor (servidor MCP `jev`), e as validações vêm de `decidir` e `escolher`. Os agentes da divisão Coordenação do seu fork já fazem isso. Para ver sem nenhum agente rodando, use o botão **Demo**.

Os ajustes do Jev feitos na tela ficam em `lera.json` e valem na próxima decisão. As variáveis `JEV_MODEL`, `JEV_LIMIAR_BAIXO` e `JEV_LIMIAR_ALTO`, se existirem, têm prioridade, e a tela avisa quando isso acontece.

## Acesso pelo celular

O servidor continua no seu PC. O celular chega até ele pelo [Tailscale](https://tailscale.com), uma rede privada entre os seus aparelhos: nada fica aberto na internet e não precisa mexer no roteador.

1. No PC (Windows): `winget install tailscale.tailscale` e entre com sua conta.
2. No celular: instale o app Tailscale e entre com **a mesma conta**.
3. No painel do Tailscale, em **DNS**, ative **HTTPS Certificates**.
4. No PC, defina a senha do acesso remoto: `leradeveloper --senha`
5. Com o leradeveloper rodando, publique a porta só na sua rede: `tailscale serve --bg 4747`
6. No celular, abra o endereço que o comando mostrou (`https://<seu-pc>.<sua-rede>.ts.net`) e entre com a senha.

Proteções: só endereços `*.ts.net` são aceitos, a senha é guardada com scrypt, a sessão dura 30 dias em cookie seguro, e 5 senhas erradas bloqueiam novas tentativas por 15 minutos. Trocar a senha encerra todas as sessões. Para desligar: `leradeveloper --remoto-desligar` e `tailscale serve reset`.

O PC precisa estar ligado, com o leradeveloper aberto, para o celular acessar.

## Decisor Jev

O leradeveloper traz o `lera-decisor`, um servidor MCP que dá aos seus agentes um decisor baseado no **Jev** (TypeSafe), acessado pelo defapi. Os agentes chamam o decisor antes de rotear, aprovar ou escolher caminhos:

- **`decidir`**: pergunta de sim/não. Acima de 70% ou abaixo de 30% a decisão é confiante; entre 30% e 70% o agente **para e pergunta a você**.
- **`escolher`**: ranking entre 2 e 20 opções.
- **`registrar_atividade`**: atualiza a mesa do agente no Escritório (tarefa, progresso, status).
- **`historico_decisoes`**: as últimas decisões tomadas nesta máquina.

Para configurar:

1. Salve a chave do defapi na variável de usuário `TYPESAFE_API_KEY` (no Windows, em "Editar as variáveis de ambiente para sua conta").
2. Teste a chave: `lera-decisor --testar`
3. Ligue o decisor ao Claude Code, ao Codex e ao Cursor de uma vez: `lera-decisor --instalar`. Cada arquivo de configuração alterado ganha uma cópia `.bak-lera` antes.
4. Reinicie as ferramentas. No Claude Code, `/mcp` deve mostrar `jev` conectado.

O modelo e os limites da zona de dúvida são ajustados na tela **Escritório → Config**, ou pelas variáveis `JEV_MODEL`, `JEV_LIMIAR_BAIXO` e `JEV_LIMIAR_ALTO`. O Jev não faz contas nem compara datas: os agentes calculam esses fatos antes e mandam o resultado no contexto.

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
