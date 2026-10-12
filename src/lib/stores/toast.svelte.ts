/**
 * Toast queue — non-blocking transient notifications.
 * Auto-dismiss timing per spec: success/info 4s, warning 7s, error persistent.
 */

export type ToastKind = "success" | "info" | "warning" | "error";

/** Optional inline action button on a toast — e.g., "Re-authorize" on
 *  a ScopeRequired error toast. When the user clicks, `onClick` runs
 *  and the toast auto-dismisses (clicking the action implies the user
 *  has acknowledged the toast). */
export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  action?: ToastAction;
}

class ToastStore {
  items: Toast[] = $state([]);
  private nextId = 1;

  push(kind: ToastKind, title: string, body?: string, action?: ToastAction) {
    const id = this.nextId++;
    this.items = [...this.items, { id, kind, title, body, action }];
    if (kind !== "error") {
      const ms = kind === "warning" ? 7000 : 4000;
      setTimeout(() => this.dismiss(id), ms);
    }
  }

  success(title: string, body?: string, action?: ToastAction) { this.push("success", title, body, action); }
  info(title: string, body?: string, action?: ToastAction)    { this.push("info", title, body, action); }
  warning(title: string, body?: string, action?: ToastAction) { this.push("warning", title, body, action); }
  error(title: string, body?: string, action?: ToastAction)   { this.push("error", title, body, action); }

  /** Invoked when the user clicks a toast's action button. Runs the
   *  callback then dismisses the toast. */
  async invokeAction(id: number) {
    const t = this.items.find((x) => x.id === id);
    if (!t?.action) return;
    try {
      await t.action.onClick();
    } finally {
      this.dismiss(id);
    }
  }

  dismiss(id: number) {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toast = new ToastStore();
