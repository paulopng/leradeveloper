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

## Central de comando

Em `http://127.0.0.1:4747/central` (ou **Central** na barra lateral) o leradeveloper comanda o **Claude Code**, o **Codex**, o **Cursor** e o **Antigravity** instalados no seu PC. Pelo celular, funciona pelo mesmo endereço do Tailscale.

**Com o assistente (padrão).** Conte a ideia do jeito que vier. O assistente (Claude Code por padrão, só leitura) lê o projeto, pergunta só o que importa, com respostas sugeridas que você toca (ou **Pular: decida você**), e monta o briefing: objetivo, critérios de aceite, validações, premissas, riscos, fora do escopo e a **equipe**, ou seja, as tarefas, a ferramenta de cada uma (distribuídas pelos pontos fortes de cada ferramenta e pelos limites de uso) e os agentes do catálogo de cada tarefa. O Jev valida o briefing (objetivo claro, critérios verificáveis, equipe cobre tudo, tarefas sem sobreposição, fiel à ideia, prontidão) e sugere a ferramenta de cada tarefa; se reprovar, o assistente corrige uma vez sozinho. Você troca ferramenta e agentes, pede mudanças na caixa de baixo e toca em **Montar a equipe e começar**: vira um objetivo com essas escolhas, e os critérios e validações vão junto para cada agente e para a revisão do Jev.

**Tarefa.** Escolha o projeto, escreva o que quer, escolha a ferramenta (ou deixe o Jev escolher) e mande. A conversa aparece ao vivo: o que a ferramenta diz, os arquivos que mexe, os comandos que roda e o plano dela. Quando ela pede para rodar um comando, aparece um cartão com **Permitir**, **Sempre nesta tarefa** e **Negar**. Comandos arriscados vêm marcados, com a avaliação do Jev. Depois, dá para continuar a conversa, ver as mudanças, **revisar com o Jev**, fazer **commit** e **push**.

**Objetivo (time).** Escreva um objetivo maior. O Claude Code lê o projeto (só leitura) e monta um plano de tarefas; o Jev escolhe a ferramenta de cada uma. Você revisa, troca o que quiser e aprova. Cada tarefa roda numa cópia separada do projeto (git worktree), em paralelo quando não depende de outra. O Jev revisa cada resultado: se aprovar, junta na branch de integração; se pedir ajuste, a ferramenta corrige uma vez; se ficar em dúvida, pergunta a você. Conflitos podem ser resolvidos pelo Claude Code com a sua aprovação. Nada muda na sua pasta até você apertar **Levar para a sua branch**.

**Autonomia** (por tarefa ou objetivo):

| Opção | O que acontece |
|---|---|
| Editar livre, comandos pedem (padrão) | Cria e altera arquivos do projeto sem perguntar; comandos pedem sua aprovação |
| Tudo pede aprovação | Arquivos e comandos pedem aprovação |
| Automático com o Jev | Comandos comuns rodam direto; os da lista de arriscados pedem você, com a avaliação do Jev |

O Cursor só altera arquivos sem tela em modo automático, então nas tarefas dele os comandos rodam sem pedir aprovação. A tela avisa, e o coordenador evita mandar para ele tarefas que dependem de muitos comandos.

**Agentes do catálogo por tarefa.** Com "Agentes: automático", o Jev lê o pedido, avalia os especialistas do catálogo que têm relação com ele e liga só os úteis (até 3), no formato da ferramenta: subagentes no Claude Code, agentes no Codex, regras no Cursor, skills no Antigravity. Quando a tarefa termina, eles saem do projeto. Agentes que você já tinha instalado ficam como estavam.

**Contas e limites.** O painel mostra a conta de cada ferramenta e o uso:

| Ferramenta | O que aparece |
|---|---|
| Claude Code | tipo de login (assinatura ou chave de API), e-mail, uso da sessão de 5 h e da semana (depois da primeira tarefa) |
| Codex | conta ChatGPT e plano, uso da janela de 5 h e da semana, com hora de renovação |
| Cursor | login; uso contado pela Central e o limite mensal que você definir |
| Antigravity | uso contado pela Central e o limite mensal que você definir |

Na escolha automática, ferramenta com 90% ou mais de uso fica de fora.

**Projetos.** A Central e o Catálogo usam a mesma lista de projetos: pastas adicionadas em um aparecem no outro. O `leradeveloper` abre direto na Central; o catálogo continua em **Catálogo**.

Requisitos: ter instalado e logado o que quiser usar (`claude`, `codex`, o Cursor CLI `agent` e o Antigravity CLI `agy`, que substituiu o Gemini CLI). Para o Claude Code usar a sua assinatura, entre com `claude` → `/login`. Cada tarefa vira uma mesa no Escritório, com a barra de progresso.

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

O leradeveloper traz o `lera-decisor`, um servidor MCP que dá aos seus agentes um decisor baseado no **Jev** (TypeSafe), acessado pelo defapi. O Jev não escreve texto: devolve probabilidades calibradas para perguntas fechadas. O decisor usa os três tipos de pergunta do Jev e várias perguntas por chamada:

| Ferramenta | Tipo no Jev | Para quê |
|---|---|---|
| `decidir` | noul (sim/não) | aprovar, seguir, escalar |
| `escolher` | choice | qual agente, qual abordagem; inclui "nenhuma das opções" |
| `avaliar` | score | severidade, risco, prontidão em níveis descritos; `limite_humano` |
| `consultar` | vários, numa chamada | decompor uma decisão em perguntas independentes |
| `revisar_mudanca` | 6 perguntas prontas | portão antes de merge: aprovar, ajustar, refazer ou humano |
| `registrar_resultado` | — | o que aconteceu de verdade, para medir e calibrar |
| `registrar_atividade` | — | a mesa do agente no Escritório |
| `historico_decisoes` | — | as últimas decisões, com o resultado |

Quando o Jev fica em dúvida (por padrão, entre 30% e 70%), a escala passa do limite ou a revisão pede, o agente **para e pergunta a você**. Se o provedor não aceitar `choice` ou `score`, o decisor emula com perguntas sim/não e segue funcionando. Pedidos com o Jev ocupado (429/529) são repetidos sozinhos.

Para configurar:

1. Salve a chave do defapi na variável de usuário `TYPESAFE_API_KEY` (no Windows, em "Editar as variáveis de ambiente para sua conta").
2. Teste: `lera-decisor --testar` (faz uma pergunta sim/não e uma consulta com choice e score).
3. Ligue o decisor ao Claude Code, ao Codex e ao Cursor de uma vez: `lera-decisor --instalar`. Cada arquivo de configuração alterado ganha uma cópia `.bak-lera` antes.
4. Reinicie as ferramentas. No Claude Code, `/mcp` deve mostrar `jev` conectado.

### Guarda do Claude Code (opcional)

`lera-decisor --instalar-guarda` adiciona um hook ao Claude Code. Antes de comandos arriscados (`git push`, `reset --hard`, `rm -rf`, `npm publish`, `terraform apply`...), o Jev avalia se o comando é destrutivo ou afeta algo fora da sua cópia local. Se houver risco, o Claude Code pede a sua confirmação. O guarda nunca libera nem bloqueia nada sozinho, e comandos comuns passam sem custo. Para tirar: `lera-decisor --remover-guarda`.

### Calibração

O Jev é calibrado no conjunto, mas a zona de dúvida certa depende do seu uso. No **Escritório → Jev**, marque em cada validação o que aconteceu de verdade (ou deixe os agentes usarem `registrar_resultado`). Com 30 decisões sim/não marcadas, a tela mostra o acerto, o Brier e o previsto contra o real por faixa, e sugere limites para errar no máximo 10% fora da zona de dúvida. Um clique aplica.

### Boas práticas (já embutidas nos agentes da divisão Coordenação)

- Perguntas, opções e níveis **em inglês**, onde o Jev é mais preciso. A conversa com você continua em português.
- Contexto como objeto JSON com campos citados na pergunta entre crases.
- Opções e níveis descritos como para um colega novo, níveis do menor para o maior.
- Contas, contagens e datas calculadas antes: o Jev não faz aritmética.

O modelo e os limites da zona de dúvida são ajustados na tela **Escritório → Config**, ou pelas variáveis `JEV_MODEL`, `JEV_LIMIAR_BAIXO` e `JEV_LIMIAR_ALTO`.

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
