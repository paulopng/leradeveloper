// Utilidades comuns aos adaptadores.

/** Chama fn para cada linha completa do stream. */
export function linhas(stream, fn) {
  let buf = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) fn(line);
    }
  });
  stream.on("end", () => {
    if (buf.trim()) fn(buf.trim());
    buf = "";
  });
}

const curto = (s, n = 160) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Uma linha legível sobre a chamada de ferramenta. */
export function resumoFerramenta(nome, input = {}) {
  const i = input ?? {};
  switch (nome) {
    case "Bash":
    case "PowerShell":
      return `$ ${curto(i.command)}`;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `editar ${curto(i.file_path ?? i.notebook_path)}`;
    case "Read":
      return `ler ${curto(i.file_path)}`;
    case "Grep":
      return `buscar "${curto(i.pattern, 60)}"${i.path ? ` em ${curto(i.path, 60)}` : ""}`;
    case "Glob":
      return `listar ${curto(i.pattern)}`;
    case "WebFetch":
      return `abrir ${curto(i.url)}`;
    case "WebSearch":
      return `pesquisar "${curto(i.query, 80)}"`;
    case "Task":
    case "Agent":
      return `subagente: ${curto(i.description ?? i.subagent_type)}`;
    case "TodoWrite":
      return "atualizar a lista de tarefas";
    default:
      if (nome?.startsWith("mcp__")) return `${nome.split("__").slice(1).join(".")}`;
      return curto(JSON.stringify(i), 120);
  }
}

export { curto };
