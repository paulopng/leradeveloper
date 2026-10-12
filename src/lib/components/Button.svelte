<script lang="ts">
  import type { Snippet } from "svelte";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";

  type Variant = "primary" | "secondary" | "danger" | "ghost" | "link";
  type Size = "sm" | "md" | "lg";

  interface Props {
    variant?: Variant;
    size?: Size;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    loading?: boolean;
    title?: string;
    ariaLabel?: string;
    /** Tag this button so Modal's defaultFocus="cancel"|"confirm" can find it. */
    modalAction?: "cancel" | "confirm";
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
    icon?: Snippet;
  }

  let {
    variant = "secondary",
    size = "md",
    type = "button",
    disabled = false,
    loading = false,
    title,
    ariaLabel,
    modalAction,
    onclick,
    children,
    icon,
  }: Props = $props();
</script>

<button
  class="btn btn-{variant} btn-{size}"
  class:loading
  {type}
  {title}
  aria-label={ariaLabel}
  data-modal-action={modalAction}
  disabled={disabled || loading}
  {onclick}
>
  {#if loading}
    <span class="ico spin" aria-hidden="true"><LoaderCircle size={size === "sm" ? 14 : 16} /></span>
  {:else if icon}
    <span class="ico" aria-hidden="true">{@render icon()}</span>
  {/if}
  <span class="label">{@render children()}</span>
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    border-radius: var(--radius-md);
    font-family: var(--font-sans);
    font-weight: var(--fw-medium);
    line-height: 1;
    white-space: nowrap;
    user-select: none;
    transition:
      background-color var(--motion-duration-fast) var(--motion-ease-out),
      border-color var(--motion-duration-fast) var(--motion-ease-out),
      color var(--motion-duration-fast) var(--motion-ease-out);
  }
  .btn:disabled { opacity: 0.5; pointer-events: none; }

  /* sizes */
  .btn-sm { height: 24px; padding: 0 var(--space-2); font-size: var(--text-body-sm); }
  .btn-md { height: 28px; padding: 0 var(--space-3); font-size: var(--text-body); }
  .btn-lg { height: 36px; padding: 0 var(--space-4); font-size: var(--text-body); }

  /* variants */
  .btn-primary {
    background: var(--color-brand);
    color: var(--color-text-inverse);
    border: 1px solid transparent;
  }
  .btn-primary:hover { background: var(--color-brand-hover); }
  .btn-primary:active { background: var(--color-brand-active); }

  .btn-secondary {
    background: var(--color-surface-raised);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
  }
  .btn-secondary:hover { background: var(--color-surface-sunken); border-color: var(--color-border-strong); }

  .btn-danger {
    background: var(--color-danger);
    color: var(--color-text-inverse);
    border: 1px solid transparent;
  }
  .btn-danger:hover { filter: brightness(1.06); }

  .btn-ghost {
    background: transparent;
    color: var(--color-text-primary);
    border: 1px solid transparent;
  }
  .btn-ghost:hover { background: var(--color-surface-sunken); }

  .btn-link {
    background: transparent;
    color: var(--color-text-link);
    border: 1px solid transparent;
    height: auto;
    padding: 0;
  }
  .btn-link:hover { text-decoration: underline; }

  .ico {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .spin :global(svg) {
    animation: spin 800ms linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
